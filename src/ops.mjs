// Operaciones del canal: retornan {code, data}; NUNCA escriben stdout.
// Presentación: cli-core imprime; mcp-core envuelve en JSON-RPC. (Fix
// BLOCKER ronda 3: contaminación del protocolo MCP.)

import { cargarMatriz } from './matriz.mjs';
import { canonizar } from './plantillas.mjs';
import { argsCaptura } from './stt.mjs';
import {
  adquirirCanal, liberarCanal, resetStop, detenerCanalRemoto, nuevoTemporal,
} from './canal.mjs';
import { rm } from 'node:fs/promises';

function err(code, cause) {
  return Object.assign(new Error(code), { code, cause });
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
  const args = parseArgs(argv, { '--text': 'text', '--engine': 'engine' });
  if (!args?.text) return { code: 2, data: { error: 'usage' } };
  return speakCore(args);
}

// Núcleo de speak con objeto directo {text, engine?}. MCP inyecta aquí:
// re-serializar a argv re-parseaba y rechazaba texto legítimo que inicia
// con '--' como usage falso (ronda 5, M-5).
export async function speakCore(args) {
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
  await adquirirCanal().catch((e) => {
    throw err(e.code ?? 'internal_error');
  });
  resetStop();
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
    return { code: 1, data: { error: e.code ?? 'internal_error' } };
  } finally {
    if (tmpWav) await rm(tmpWav, { force: true }).catch(() => {});
    await liberarCanal();
  }
}

export async function listenOp(argv) {
  const { listen } = await import('./stt.mjs');
  return listen(argv);
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
  const { access, constants } = await import('node:fs/promises');
  const tts = cfg.engines.tts.map((e) => ({
    id: e.id, adapter: e.adapter, available: e.available,
    selected: e.selected && e.available,
  }));
  // STT curado como TTS: disponibilidad, no rutas del filesystem
  // (ronda 5: exponía whisper_bin/whisper_model al consumidor MCP)
  let sttOk = false;
  try {
    await access(cfg.engines.stt.whisper_bin, constants.F_OK);
    await access(cfg.engines.stt.whisper_model, constants.F_OK);
    sttOk = true;
  } catch {}
  return { code: 0, data: { tts, stt: { available: sttOk } } };
}

// Diagnóstico de adopción (doctor, C0.2): checks cerrados, causas del
// conjunto cerrado de los adaptadores + esta sección. Salida contractual
// por stdout; exit 0 sólo si TODO está operativo. El `detalle` de config
// es la causa textual de matriz (ruta local, no secreto).
export async function doctorOp() {
  const { access, constants } = await import('node:fs/promises');
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

  const cap = argsCaptura(process.platform);
  const rutaFfmpeg = process.env.GLOSOMATA_FFMPEG ?? cap?.bin;
  let ffmpeg;
  if (!rutaFfmpeg) {
    ffmpeg = { ok: false, causa: 'plataforma_no_soportada' };
  } else {
    try {
      await access(rutaFfmpeg, constants.F_OK);
      ffmpeg = { ok: true };
    } catch {
      ffmpeg = { ok: false, causa: 'ffmpeg_ausente' };
    }
  }

  let whisper;
  if (!cfg) {
    whisper = { ok: false, causa: 'config_unreadable' };
  } else {
    try {
      await access(cfg.engines.stt.whisper_bin, constants.F_OK);
      whisper = { ok: true };
    } catch {
      whisper = { ok: false, causa: 'whisper_bin_ausente' };
    }
    if (whisper.ok) {
      try {
        await access(cfg.engines.stt.whisper_model, constants.F_OK);
      } catch {
        whisper = { ok: false, causa: 'whisper_model_ausente' };
      }
    }
  }

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
export async function speakMcp(args) {
  return speakCore(args);
}
