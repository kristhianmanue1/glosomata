// Phonon en Ollama local: HTTP de loopback a través de curl en subprocess.
// El texto va por stdin; nunca se incluye en argv ni en logs. No hay pull.

import { access, constants, writeFile } from 'node:fs/promises';
import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

const CURL = '/usr/bin/curl';
const HOST = 'http://127.0.0.1:11434';
const MAX_SHOW = 256 * 1024;
const MAX_WAV = 16 * 1024 * 1024;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/;

function ttsError() {
  return Object.assign(new Error('tts_failed'), { code: 'tts_failed' });
}

function validModel(model) {
  return typeof model === 'string' && model.length <= 256
    && MODEL_NAME.test(model);
}

function validVoice(voice) {
  return typeof voice === 'string' && voice.length > 0 && voice.length <= 100
    && !/[\u0000-\u001f]/u.test(voice);
}

function curlArgs(path, timeoutS) {
  // -q primero: ignora .curlrc. La URL fija y --noproxy impiden salida
  // accidental a un proxy o a un host configurado por el entorno.
  return ['-q', '--noproxy', '*', '--proto', '=http', '--max-redirs', '0',
    '--fail', '--silent', '--show-error', '--max-time', String(timeoutS),
    '--header', 'Content-Type: application/json', '--data-binary', '@-',
    `${HOST}${path}`];
}

function solicitar(bin, path, body, maxBytes, timeoutS, cancelable) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(bin, curlArgs(path, timeoutS));
    const chunks = [];
    let total = 0;
    let exceeded = false;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fn(value);
    };
    const poll = cancelable ? setInterval(() => {
      if (stopPedido()) matarGrupo(child);
    }, 50) : null;
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        matarGrupo(child);
      } else {
        chunks.push(chunk);
      }
    });
    child.on('error', () => done(reject, ttsError()));
    child.on('close', (code) => {
      if (cancelable && stopPedido()) return done(resolve, 'stopped');
      if (code !== 0 || exceeded || total === 0) {
        return done(reject, ttsError());
      }
      done(resolve, Buffer.concat(chunks, total));
    });
    child.stdin.end(JSON.stringify(body));
  });
}

// Inyección limitada a pruebas de frontera de proceso. CLI/MCP siempre
// usan /usr/bin/curl; una matriz no puede sustituir el ejecutable.
export function createRequesterForTesting(bin) {
  return (path, body, maxBytes, timeoutS, cancelable) =>
    solicitar(bin, path, body, maxBytes, timeoutS, cancelable);
}

const request = createRequesterForTesting(CURL);

function wavValido(wav) {
  // Ollama emite cabecera de tamaño máximo para permitir streaming; la
  // duración real sale de los bytes recibidos, no de esos campos.
  return wav.length > 44 && (wav.length - 44) % 2 === 0
    && wav.toString('ascii', 0, 4) === 'RIFF'
    && wav.toString('ascii', 8, 16) === 'WAVEfmt '
    && wav.readUInt32LE(16) === 16
    && wav.readUInt16LE(20) === 1
    && wav.readUInt16LE(22) === 1
    && wav.readUInt32LE(24) === 24000
    && wav.readUInt32LE(28) === 48000
    && wav.readUInt16LE(32) === 2
    && wav.readUInt16LE(34) === 16
    && wav.toString('ascii', 36, 40) === 'data';
}

export async function diagnostico(cfg, requester = request) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    return { ok: false, causa: 'plataforma_no_soportada' };
  }
  try {
    await access('/usr/bin/afplay', constants.X_OK);
  } catch {
    return { ok: false, causa: 'afplay_ausente' };
  }
  try {
    await access(CURL, constants.X_OK);
  } catch {
    return { ok: false, causa: 'binario_ausente' };
  }
  if (cfg.bin !== undefined && cfg.bin !== CURL) {
    return { ok: false, causa: 'probe_fallido' };
  }
  if (!validModel(cfg.model)) return { ok: false, causa: 'modelo_ausente' };
  if (!validVoice(cfg.voice)) return { ok: false, causa: 'probe_fallido' };
  try {
    const raw = await requester('/api/show', { model: cfg.model },
      MAX_SHOW, 3, false);
    const show = JSON.parse(raw.toString('utf8'));
    const speech = Array.isArray(show.capabilities)
      && show.capabilities.includes('speech');
    const voice = Array.isArray(show.voices)
      && show.voices.some((v) => typeof v === 'string'
        && v.toLocaleLowerCase() === cfg.voice.toLocaleLowerCase());
    return speech && voice ? { ok: true }
      : { ok: false, causa: 'probe_fallido' };
  } catch {
    return { ok: false, causa: 'probe_fallido' };
  }
}

export async function disponible(cfg) {
  return (await diagnostico(cfg)).ok;
}

// Exportada para verificar la frontera de proceso sin activar altavoces.
export async function sintetizar(cfg, texto, tmpWav, requester = request) {
  if (stopPedido()) return 'stopped';
  const wav = await requester('/v1/audio/speech', {
    model: cfg.model, voice: cfg.voice, input: texto, response_format: 'wav',
  }, MAX_WAV, 60, true);
  if (wav === 'stopped' || stopPedido()) return 'stopped';
  if (!wavValido(wav)) throw ttsError();
  await writeFile(tmpWav, wav, { mode: 0o600 });
  return stopPedido() ? 'stopped' : 'ok';
}

export async function hablar(cfg, texto, { tmpWav }) {
  const synth = await sintetizar(cfg, texto, tmpWav);
  if (synth === 'stopped') return { played: false, echo: null, truncated: true };
  return new Promise((resolve, reject) => {
    const child = spawnGrupo('/usr/bin/afplay', [tmpWav]);
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fn(value);
    };
    const poll = setInterval(() => {
      if (stopPedido()) matarGrupo(child);
    }, 50);
    child.on('error', () => done(reject,
      Object.assign(new Error('audio_device_error'), { code: 'audio_device_error' })));
    child.on('close', (code) => {
      if (stopPedido()) {
        return done(resolve, { played: false, echo: null, truncated: true });
      }
      if (code === 0) {
        return done(resolve, { played: true, echo: texto, truncated: false });
      }
      done(reject, Object.assign(new Error('audio_device_error'),
        { code: 'audio_device_error' }));
    });
  });
}
