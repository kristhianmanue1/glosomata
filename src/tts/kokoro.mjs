// Adaptador kokoro (MLX) — subprocess python, JSON por stdin, WAV por el
// script, afplay. Códigos del script mapeados a la taxonomía cerrada.

import { access, constants } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const MAX_OUT = 64 * 1024;

const MAPEO = {
  text_too_long: 'text_too_long',
  tts_failed: 'tts_failed',
  input_invalid: 'tts_failed',
  pitch_invalid: 'tts_failed',
  ffmpeg_missing: 'tts_failed',
};

export async function disponible(cfg) {
  try {
    await access(cfg.python, constants.F_OK);
    await access(cfg.script ?? join(AQUI, 'synthesize_kokoro.py'), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function hablar(cfg, texto, { tmpWav }) {
  const script = cfg.script ?? join(AQUI, 'synthesize_kokoro.py');
  // 1) sintetizar
  const synth = await new Promise((resolve, reject) => {
    const child = spawnGrupo(cfg.python, [script]);
    let out = '';
    child.stdout.on('data', (d) => {
      if (out.length < MAX_OUT) out += d.toString();
    });
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
      let r;
      try {
        r = JSON.parse(out);
      } catch {
        return reject(Object.assign(new Error('tts_failed'), { code: 'tts_failed', cause: `salida ilegible exit ${code}` }));
      }
      if (code === 0 && r.ok) return resolve('ok');
      const codigo = MAPEO[r.error] ?? 'tts_failed';
      reject(Object.assign(new Error(codigo), { code: codigo }));
    });
    child.stdin.write(JSON.stringify({
      texto,
      voice: cfg.voice,
      pitch_scale: cfg.pitch_scale,
      out: tmpWav,
    }));
    child.stdin.end();
  });
  if (synth === 'stopped') return { played: false, echo: null, truncated: true };
  // 2) reproducir
  return await new Promise((resolve, reject) => {
    const play = spawnGrupo('/usr/bin/afplay', [tmpWav]);
    let poll2;
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
    poll2 = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll2);
        matarGrupo(play);
        resolve({ played: false, echo: null, truncated: true });
      }
    }, 50);
  });
}
