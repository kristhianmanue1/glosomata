// STT: ffmpeg (avfoundation) → WAV 16 kHz mono → whisper-cli.
// Retorna {code, data}; nunca escribe stdout.

import { cargarMatriz } from './matriz.mjs';
import {
  adquirirCanal, liberarCanal, resetStop, stopPedido,
  spawnGrupo, matarGrupo, nuevoTemporal,
} from './canal.mjs';
import { rm, stat, readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';

const FFMPEG = process.env.GLOSOMATA_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const UMBRAL_RMS = 120; // amplitud media mínima (s16le) para considerar voz

async function correr(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(cmd, args);
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => {
      if (stdout.length < 200_000) stdout += d.toString();
    });
    const poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        matarGrupo(child);
        reject(Object.assign(new Error('stopped'), { code: 'stopped' }));
      }
    }, 50);
    child.on('error', () => {
      clearInterval(poll);
      reject(Object.assign(new Error('spawn'), { code: 'spawn' }));
    });
    child.on('close', (code) => {
      clearInterval(poll);
      resolve({ code, stdout });
    });
  });
}

function rmsS16(buf) {
  let suma = 0;
  const n = buf.length / 2;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    suma += v * v;
  }
  return n ? Math.sqrt(suma / n) : 0;
}

export async function listen(argv) {
  const cfg = await cargarMatriz();
  let timeout = cfg.constraints?.listen_default_timeout_s ?? 10;
  const i = argv.indexOf('--timeout');
  if (i >= 0) {
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0 || v > 120) {
      return { code: 2, data: { error: 'usage' } };
    }
    timeout = v;
  }
  try {
    await access(FFMPEG);
  } catch {
    return { code: 1, data: { error: 'audio_device_error', causa: 'ffmpeg ausente' } };
  }
  try {
    await adquirirCanal();
  } catch (e) {
    return { code: 1, data: { error: e.code ?? 'internal_error' } };
  }
  resetStop();
  const t = await nuevoTemporal('stt');
  await t.handle.close();
  try {
    let captura;
    try {
      captura = await correr(FFMPEG, [
        '-y', '-loglevel', 'error',
        '-f', 'avfoundation', '-i', ':0',
        '-t', String(timeout),
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        t.ruta,
      ]);
    } catch (e) {
      if (e.code === 'stopped') return { code: 1, data: { error: 'stopped' } };
      return { code: 1, data: { error: 'audio_device_error' } };
    }
    if (captura.code !== 0) {
      return { code: 1, data: { error: 'mic_denied' } };
    }
    // silencio: RMS del archivo completo por debajo del umbral
    const wav = await readFile(t.ruta);
    const pcm = wav.subarray(44);
    if (pcm.length < 3200 || rmsS16(pcm) < UMBRAL_RMS) {
      return { code: 1, data: { error: 'mic_timeout' } };
    }
    let trans;
    try {
      trans = await correr(cfg.engines.stt.whisper_bin, [
        '-m', cfg.engines.stt.whisper_model,
        '-f', t.ruta, '-l', 'es', '-nt', '-np',
      ]);
    } catch (e) {
      if (e.code === 'stopped') return { code: 1, data: { error: 'stopped' } };
      return { code: 1, data: { error: 'stt_failed' } };
    }
    if (trans.code !== 0) return { code: 1, data: { error: 'stt_failed' } };
    const transcript = trans.stdout
      .split('\n').map((l) => l.trim())
      .filter((l) => l && !/^(whisper_|main:|system_info|read_audio_data)/.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { code: 0, data: { transcript } };
  } finally {
    await rm(t.ruta, { force: true }).catch(() => {});
    await liberarCanal();
  }
}
