// STT: captura con ffmpeg (avfoundation, macOS) → WAV 16 kHz mono →
// whisper-cli. Contrato: listen [--timeout s] → {transcript} | mic_denied |
// mic_timeout | stt_failed. Temporales borrados siempre.

import { cargarMatriz } from './matriz.mjs';
import {
  adquirirCanal, liberarCanal, resetStop, stopPedido,
  spawnGrupo, matarGrupo, nuevoTemporal,
} from './canal.mjs';
import { rm } from 'node:fs/promises';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

async function correr(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(cmd, args);
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => {
      if (stderr.length < 2000) stderr += d.toString();
    });
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
    child.on('error', (e) => {
      clearInterval(poll);
      reject(Object.assign(new Error('spawn_failed'), { code: 'spawn_failed', cause: e.code }));
    });
    child.on('exit', (code) => {
      clearInterval(poll);
      resolve({ code, stderr, stdout });
    });
  });
}

export async function listen(argv) {
  const cfg = await cargarMatriz();
  const idx = argv.indexOf('--timeout');
  const timeout = idx >= 0 ? Number(argv[idx + 1]) : cfg.constraints?.listen_default_timeout_s ?? 10;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 120) {
    throw Object.assign(new Error('usage: timeout inválido'), { code: 'usage' });
  }
  await adquirirCanal();
  resetStop();
  const t = await nuevoTemporal('stt');
  await t.handle.close();
  try {
    // 1) capturar
    try {
      const r = await correr(FFMPEG, [
        '-y', '-loglevel', 'error',
        '-f', 'avfoundation', '-i', ':0',
        '-t', String(timeout),
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        t.ruta,
      ]);
      if (r.code !== 0) {
        const causa = r.stderr.toLowerCase();
        if (causa.includes('permission') || causa.includes('not authorized') || causa.includes('tcc')) {
          throw Object.assign(new Error('mic_denied'), { code: 'mic_denied' });
        }
        throw Object.assign(new Error('mic_denied'), { code: 'mic_denied', cause: 'captura fallo' });
      }
    } catch (e) {
      if (e.code === 'stopped') return { stopped: true };
      throw e;
    }
    // 2) transcribir
    const { stat } = await import('node:fs/promises');
    const s = await stat(t.ruta);
    if (s.size < 1024) {
      // captura sin voz útil: archivo minúsculo
      process.stdout.write(`${JSON.stringify({ transcript: '', nota: 'mic_timeout' })}\n`);
      return 0;
    }
    const r2 = await correr(cfg.engines.stt.whisper_bin, [
      '-m', cfg.engines.stt.whisper_model,
      '-f', t.ruta,
      '-l', 'es',
      '-nt', // sin timestamps
      '-np', // sin progreso
    ]);
    if (r2.code !== 0) {
      throw Object.assign(new Error('stt_failed'), { code: 'stt_failed' });
    }
    const transcript = r2.stdout
      .split('\n').map((l) => l.trim())
      .filter((l) => l && !/^(whisper_|main:|system_info|read_audio_data)/.test(l))
      .join(' ')
      .trim();
    process.stdout.write(`${JSON.stringify({ transcript })}\n`);
    return 0;
  } finally {
    await rm(t.ruta, { force: true });
    liberarCanal();
  }
}
