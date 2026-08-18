// Matriz de configuración v1 — carga glosomata.json y valida disponibilidad.
// Contrato: docs/specs/contrato-matriz.md

import { readFile } from 'node:fs/promises';

const RUTA_CONFIG = process.env.GLOSOMATA_CONFIG ?? 'glosomata.json';

const PROBES = {
  say: () => import('./tts/say.mjs').then((m) => m.disponible()),
  piper: (e) => import('./tts/piper.mjs').then((m) => m.disponible(e)),
  kokoro: (e) => import('./tts/kokoro.mjs').then((m) => m.disponible(e)),
};

export async function cargarMatriz(ruta = RUTA_CONFIG) {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(ruta, 'utf8'));
  } catch {
    const err = new Error('config_unreadable');
    err.code = 'config_unreadable';
    throw err;
  }
  for (const e of cfg.engines?.tts ?? []) {
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
