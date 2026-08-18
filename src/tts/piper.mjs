// Adaptador piper (GPL-3.0) — subprocess, texto por stdin, PCM crudo por
// stdout (s16le mono), WAV a temporal, afplay. Prohibido link/bundle (ADR-005).

import { access, constants } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

const MAX_PCM = 8 * 1024 * 1024; // tope del contrato: 8 MB de audio

export async function disponible(cfg) {
  try {
    await access(cfg.bin, constants.F_OK);
    await access(cfg.model, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function wavDesdePcm(raw, sampleRate = 16000) {
  const buf = Buffer.alloc(44 + raw.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + raw.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(raw.length, 40);
  raw.copy(buf, 44);
  return buf;
}

export async function hablar(cfg, texto, { tmpWav }) {
  // 1) sintetizar: PCM crudo por stdout, acumulado en memoria con tope
  const chunks = [];
  let total = 0;
  const child = spawnGrupo(cfg.bin, [
    '-m', cfg.model,
    '-f', '/dev/stdin',
    '--output-raw',
  ]);
  child.stdout.on('data', (d) => {
    total += d.length;
    if (total > MAX_PCM) {
      matarGrupo(child);
      return;
    }
    chunks.push(d);
  });
  const synthDone = new Promise((resolve, reject) => {
    child.on('error', (e) => {
      const err = new Error('tts_failed');
      err.code = 'tts_failed';
      err.cause = e.code ?? e.message;
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (total > MAX_PCM) {
        const err = new Error('tts_failed');
        err.code = 'tts_failed';
        err.cause = 'pcm_excede_max';
        reject(err);
        return;
      }
      if (code === 0) resolve();
      else {
        const err = new Error('tts_failed');
        err.code = 'tts_failed';
        err.cause = `sintesis exit ${code} signal ${signal}`;
        reject(err);
      }
    });
  });
  child.stdin.write(texto);
  child.stdin.end();
  await synthDone;
  await writeFile(tmpWav, wavDesdePcm(Buffer.concat(chunks)), { mode: 0o600 });
  if (stopPedido()) return { played: false, echo: null, truncated: true };
  // 2) reproducir
  return await new Promise((resolve, reject) => {
    const play = spawnGrupo('/usr/bin/afplay', [tmpWav]);
    const poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        matarGrupo(play);
        resolve({ played: false, echo: null, truncated: true });
      }
    }, 50);
    play.on('exit', (code) => {
      clearInterval(poll);
      if (code === 0) resolve({ played: true, echo: texto, truncated: false });
      else {
        const err = new Error('audio_device_error');
        err.code = 'audio_device_error';
        err.cause = `afplay exit ${code}`;
        reject(err);
      }
    });
    play.on('error', (e) => {
      clearInterval(poll);
      const err = new Error('audio_device_error');
      err.code = 'audio_device_error';
      err.cause = e.code ?? e.message;
      reject(err);
    });
  });
}
