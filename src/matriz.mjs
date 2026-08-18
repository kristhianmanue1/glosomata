// Matriz de configuración v1 — carga glosomata.json y valida disponibilidad.
// Contrato: docs/specs/contrato-matriz.md

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';

const RUTA_CONFIG =
  process.env.GLOSOMATA_CONFIG ?? 'glosomata.json';

async function existe(ruta) {
  try {
    await access(ruta, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

// Disponibilidad por motor: probe real, no asunción (REQ-4).
const PROBES = {
  say: async () => process.platform === 'darwin',
  piper: async (e) => existe(e.bin) && existe(e.model),
  kokoro: async (e) => existe(e.python),
};

export async function cargarMatriz(ruta = RUTA_CONFIG) {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(ruta, 'utf8'));
  } catch {
    throw new Error('config_unreadable');
  }
  for (const e of cfg.engines?.tts ?? []) {
    // fail-closed: sin kill_switch declarado, el motor no es seleccionable
    if (!e.kill_switch?.type || !e.kill_switch?.max_latency_ms) {
      e.available = false;
      continue;
    }
    const probe = PROBES[e.adapter];
    e.available = probe ? await probe(e) : false;
  }
  return cfg;
}

export async function engines() {
  const cfg = await cargarMatriz();
  const tts = cfg.engines.tts.map((e) => ({
    id: e.id,
    adapter: e.adapter,
    available: e.available,
    selected: e.selected && e.available,
  }));
  process.stdout.write(`${JSON.stringify({ tts, stt: cfg.engines.stt }, null, 2)}\n`);
  return 0;
}
