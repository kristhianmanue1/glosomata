// Adaptador kokoro (MLX, Apple Silicon) — subprocess python, JSON por stdin.

import { access, constants } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));

export async function disponible(cfg) {
  try {
    await access(cfg.python);
    await access(cfg.script ?? join(AQUI, 'synthesize_kokoro.py'));
    return true;
  } catch {
    return false;
  }
}

export async function hablar(cfg, texto, { tmpWav }) {
  const script = cfg.script ?? join(AQUI, 'synthesize_kokoro.py');
  // fase 1: sintetizar
  const synth = await new Promise((resolve, reject) => {
    const child = spawnGrupo(cfg.python, [script]);
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', (e) => {
      const err = new Error('tts_failed');
      err.code = 'tts_failed';
      err.cause = e.code ?? e.message;
      reject(err);
    });
    child.on('exit', (code) => {
      try {
        const r = JSON.parse(out);
        if (code === 0 && r.ok) return resolve();
        const err = new Error(r.error ?? 'tts_failed');
        err.code = r.error ?? 'tts_failed';
        reject(err);
      } catch {
        const err = new Error('tts_failed');
        err.code = 'tts_failed';
        err.cause = `salida ilegible exit ${code}`;
        reject(err);
      }
    });
    child.stdin.write(
      JSON.stringify({
        texto,
        voice: cfg.voice,
        pitch_scale: cfg.pitch_scale,
        out: tmpWav,
      })
    );
    child.stdin.end();
  });
  if (stopPedido()) return { played: false, echo: null, truncated: true };
  // fase 2: reproducir (afplay, mismo patrón que piper)
  return await new Promise((resolve, reject) => {
    const child = spawnGrupo('/usr/bin/afplay', [tmpWav]);
    const poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        matarGrupo(child);
        resolve({ played: false, echo: null, truncated: true });
      }
    }, 50);
    child.on('exit', (code) => {
      clearInterval(poll);
      if (code === 0) resolve({ played: true, echo: texto, truncated: false });
      else {
        const err = new Error('audio_device_error');
        err.code = 'audio_device_error';
        reject(err);
      }
    });
    child.on('error', (e) => {
      clearInterval(poll);
      const err = new Error('audio_device_error');
      err.code = 'audio_device_error';
      err.cause = e.code ?? e.message;
      reject(err);
    });
  });
}
