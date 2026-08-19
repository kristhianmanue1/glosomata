// Operaciones del canal: retornan {code, data}; NUNCA escriben stdout.
// Presentación: cli-core imprime; mcp-core envuelve en JSON-RPC. (Fix
// BLOCKER ronda 3: contaminación del protocolo MCP.)

import { cargarMatriz } from './matriz.mjs';
import { canonizar } from './plantillas.mjs';
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
