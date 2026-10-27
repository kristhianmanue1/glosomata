// Operaciones del canal: retornan {code, data}; NUNCA escriben stdout.
// Presentación: cli-core imprime; mcp-core envuelve en JSON-RPC. (Fix
// BLOCKER ronda 3: contaminación del protocolo MCP.)

import { cargarMatriz } from './matriz.mjs';
import { canonizar } from './plantillas.mjs';
import { rutaFfmpeg, diagnosticoCaptura, diagnosticoWhisper } from './stt.mjs';
import {
  adquirirCanal, liberarCanal, resetStop, stopGeneration,
  detenerCanalRemoto, nuevoTemporal,
} from './canal.mjs';
import { rm } from 'node:fs/promises';
import { measureOperation } from './duration.mjs';

// Sólo afplay en los adaptadores emite audio_device_error: una falla
// allí sí acredita playback_failed. tts_failed no identifica la etapa.
export function ttsAudioCause(code) {
  return code === 'audio_device_error' ? 'playback_failed' : null;
}

// parser estricto: valores obligatorios, no inician con '--'
export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!spec[k]) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return null;
    out[spec[k]] = v;
    i++;
  }
  return out;
}

export async function speakOp(argv) {
  const stopAtStart = stopGeneration();
  return measureOperation(() => {
    const args = parseArgs(argv, { '--text': 'text', '--engine': 'engine' });
    return !args?.text
      ? { code: 2, data: { error: 'usage' } }
      : speakRaw(args, stopAtStart);
  });
}

// Núcleo de speak con objeto directo {text, engine?}. MCP inyecta aquí:
// re-serializar a argv re-parseaba y rechazaba texto legítimo que inicia
// con '--' como usage falso (ronda 5, M-5).
export async function speakCore(args, stopAtStart = stopGeneration()) {
  return measureOperation(() => speakRaw(args, stopAtStart));
}

async function speakRaw(args, stopAtStart) {
  const cfg = await cargarMatriz();
  let motor;
  if (args.engine) {
    motor = cfg.engines.tts.find((e) => e.id === args.engine);
    if (!motor || !motor.available) {
      return { code: 1, data: { error: 'engine_unavailable' } };
    }
  } else {
    motor = cfg.engines.tts.find((e) => e.selected && e.available);
    if (!motor) return { code: 1, data: { error: 'engine_unavailable' } };
  }
  let texto;
  try {
    texto = canonizar(args.text, cfg.constraints?.max_text_chars ?? 2000);
  } catch (e) {
    return { code: 1, data: { error: e.code } };
  }
  await adquirirCanal();
  resetStop(stopAtStart);
  let tmpWav = null;
  try {
    const adaptador = await import(`./tts/${motor.adapter}.mjs`);
    if (motor.adapter !== 'say') {
      const t = await nuevoTemporal('tts');
      await t.handle.close();
      tmpWav = t.ruta;
    }
    const out = await adaptador.hablar(motor, texto, { tmpWav });
    return { code: out.played ? 0 : 1, data: { engine: motor.id, ...out } };
  } catch (e) {
    const audioCause = ttsAudioCause(e.code);
    return { code: 1, data: { error: e.code ?? 'internal_error',
      ...(audioCause ? { causa: audioCause } : {}) } };
  } finally {
    if (tmpWav) await rm(tmpWav, { force: true }).catch(() => {});
    await liberarCanal();
  }
}

export async function listenOp(argv, stopAtStart = stopGeneration()) {
  const { listen } = await import('./stt.mjs');
  return listen(argv, stopAtStart);
}

export async function stopOp() {
  // intra-proceso (MCP: el speak local ve el flag) o cross-process (señal)
  const { pedirStop } = await import('./canal.mjs');
  pedirStop();
  const remoto = await detenerCanalRemoto();
  return { code: 0, data: { stopped: true, senal_remota: remoto } };
}

export async function enginesOp() {
  const cfg = await cargarMatriz();
  const tts = cfg.engines.tts.map((e) => ({
    id: e.id, adapter: e.adapter, available: e.available,
    selected: e.selected && e.available,
  }));
  // STT curado como TTS: disponibilidad, no rutas del filesystem
  // (ronda 5: exponía whisper_bin/whisper_model al consumidor MCP)
  const sttOk = (await diagnosticoWhisper(cfg)).ok;
  return { code: 0, data: { tts, stt: { available: sttOk } } };
}

// Diagnóstico de adopción (doctor, C0.2): checks cerrados, causas del
// conjunto cerrado de los adaptadores (contrato de consumo §7.1).
// Salida contractual por stdout; exit 0 sólo si TODO está operativo.
export async function doctorOp() {
  const mayorNode = Number(process.versions.node.split('.')[0]);
  const node = { version: process.versions.node, ok: mayorNode >= 20 };
  if (!node.ok) node.causa = 'node_viejo';

  let config = { ok: true };
  let cfg = null;
  try {
    cfg = await cargarMatriz();
  } catch (e) {
    config = { ok: false, code: 'config_unreadable', detalle: String(e.cause ?? e.code) };
  }

  const tts = (cfg?.engines?.tts ?? []).map((e) => ({
    id: e.id, adapter: e.adapter, available: !!e.available,
    ...(e.available ? {} : { causa: e.causa ?? 'probe_fallido' }),
  }));

  const ffmpeg = await diagnosticoCaptura();
  const whisper = cfg
    ? await diagnosticoWhisper(cfg)
    : { ok: false, causa: 'config_unreadable' };

  const data = { node, config, tts, stt: { whisper, ffmpeg } };
  const operativo = node.ok && config.ok && tts.length > 0
    && tts.every((t) => t.available) && whisper.ok && ffmpeg.ok;
  return { code: operativo ? 0 : 1, data };
}

export async function templatesOp(argv) {
  const { templatesData } = await import('./plantillas.mjs');
  return templatesData(argv);
}

export async function sessionOp(argv) {
  const { sessionData } = await import('./sesion.mjs');
  return sessionData(argv);
}

export async function validateOp(argv) {
  const { validateData } = await import('./plantillas.mjs');
  return validateData(argv);
}

// variante para MCP con argumentos ya parseados
export async function speakMcp(args, stopAtStart = stopGeneration()) {
  if (typeof args?.text !== 'string' || !args.text) {
    return measureOperation(() => ({ code: 2, data: { error: 'usage' } }));
  }
  return speakCore(args, stopAtStart);
}

export async function configOp(argv) {
  const { configData } = await import('./matriz.mjs');
  return configData(argv);
}
