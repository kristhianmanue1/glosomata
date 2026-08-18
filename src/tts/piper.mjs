// Adaptador piper (GPL-3.0) — subprocess, texto por stdin, PCM crudo por
// stdout (s16le mono, sample_rate de config — el modelo es 22050), WAV a
// temporal, afplay. Prohibido link/bundle (ADR-005).

import { access, constants, writeFile } from 'node:fs/promises';
import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

const MAX_PCM = 8 * 1024 * 1024;

export async function disponible(cfg) {
  try {
    await access(cfg.bin, constants.F_OK);
    await access(cfg.model, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function wavDesdePcm(raw, sampleRate) {
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
  const rate = cfg.sample_rate ?? 22050;
  // 1) sintetizar: PCM por stdout, acumulado en memoria con tope.
  // 'close' (no 'exit'): espera el drenaje de stdout (fix race ronda 3).
  const chunks = [];
  let total = 0;
  let excedido = false;
  const child = spawnGrupo(cfg.bin, [
    '-m', cfg.model, '-f', '/dev/stdin', '--output-raw',
  ]);
  child.stdout.on('data', (d) => {
    total += d.length;
    if (total > MAX_PCM) {
      excedido = true;
      matarGrupo(child);
      return;
    }
    chunks.push(d);
  });
  const synthDone = new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        matarGrupo(child);
        resolve('stopped');
      }
    }, 50);
    child.on('error', (e) => {
      clearInterval(poll);
      reject(Object.assign(new Error('tts_failed'), { code: 'tts_failed', cause: e.code }));
    });
    child.on('close', (code) => {
      clearInterval(poll);
      if (stopPedido()) return resolve('stopped');
      if (excedido) {
        return reject(Object.assign(new Error('tts_failed'), { code: 'tts_failed', cause: 'pcm_excede_max' }));
      }
      if (code === 0) resolve('ok');
      else {
        reject(Object.assign(new Error('tts_failed'), { code: 'tts_failed', cause: `sintesis exit ${code}` }));
      }
    });
  });
  child.stdin.write(texto);
  child.stdin.end();
  const estado = await synthDone;
  if (estado === 'stopped') return { played: false, echo: null, truncated: true };
  await writeFile(tmpWav, wavDesdePcm(Buffer.concat(chunks), rate), { mode: 0o600 });
  // 2) reproducir
  return await new Promise((resolve, reject) => {
    const play = spawnGrupo('/usr/bin/afplay', [tmpWav]);
    play.on('close', (code) => {
      clearInterval(poll2);
      if (code === 0) resolve({ played: true, echo: texto, truncated: false });
      else if (stopPedido()) resolve({ played: false, echo: null, truncated: true });
      else {
        reject(Object.assign(new Error('audio_device_error'), { code: 'audio_device_error', cause: `afplay exit ${code}` }));
      }
    });
    play.on('error', (e) => {
      clearInterval(poll2);
      reject(Object.assign(new Error('audio_device_error'), { code: 'audio_device_error', cause: e.code }));
    });
    const poll2 = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll2);
        matarGrupo(play);
        resolve({ played: false, echo: null, truncated: true });
      }
    }, 50);
  });
}
