// Matriz de configuración v1 — carga glosomata.json y valida disponibilidad.
// Contrato: docs/specs/specs-y-contratos-v1.md (§ matriz)

import { readFile } from 'node:fs/promises';

const RUTA_CONFIG = process.env.GLOSOMATA_CONFIG ?? 'glosomata.json';

const PROBES = {
  say: () => import('./tts/say.mjs').then((m) => m.disponible()),
  piper: (e) => import('./tts/piper.mjs').then((m) => m.disponible(e)),
  kokoro: (e) => import('./tts/kokoro.mjs').then((m) => m.disponible(e)),
};

function errConfig(cause) {
  const err = new Error('config_unreadable');
  err.code = 'config_unreadable';
  err.cause = cause;
  return err;
}

export async function cargarMatriz(ruta = RUTA_CONFIG) {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(ruta, 'utf8'));
  } catch {
    throw errConfig(`ilegible: ${ruta}`);
  }
  // estructura mínima fail-closed: sin esto, una config sin engines
  // reventaba con TypeError fuera de la taxonomía (ronda 5, M-6)
  if (typeof cfg !== 'object' || cfg === null
      || !Array.isArray(cfg.engines?.tts)
      || typeof cfg.engines?.stt !== 'object' || cfg.engines.stt === null) {
    throw errConfig('estructura inválida: engines.tts[] y engines.stt{} requeridos');
  }
  for (const e of cfg.engines.tts) {
    // fail-closed: sin kill_switch declarado, el motor no es seleccionable
    if (!e.kill_switch?.type || !e.kill_switch?.max_latency_ms) {
      e.available = false;
      continue;
    }
    const probe = PROBES[e.adapter];
    e.available = probe ? await probe(e).catch(() => false) : false;
  }
  return cfg;
}
