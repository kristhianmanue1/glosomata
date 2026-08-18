// Sesión efímera v1 — la posee el agente; glosomata jamás la muta.
// Metadata consultiva: NINGÚN requisito de seguridad depende de ella (ADR-001).

import { randomUUID } from 'node:crypto';
import { CATALOGO, validarPlantilla } from './plantillas.mjs';

const TTL_MIN_DEF = 15;

export function acunar(template = null, ttlMin = TTL_MIN_DEF) {
  if (template !== null) validarPlantilla(template);
  return {
    schema: 'glosomata/sesion-v1',
    id: randomUUID(),
    template,
    turn: 0,
    created_at: new Date().toISOString(),
    ttl_min: ttlMin,
  };
}

export function expirada(ses, ahora = Date.now()) {
  const created = Date.parse(ses.created_at ?? '');
  if (!Number.isFinite(created)) return true;
  return ahora - created > (ses.ttl_min ?? TTL_MIN_DEF) * 60_000;
}

export async function session(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'new') {
    const err = new Error('usage: session new [--template <id>]');
    err.code = 'usage';
    throw err;
  }
  const tIdx = rest.indexOf('--template');
  let template = null;
  if (tIdx >= 0) {
    const id = rest[tIdx + 1];
    if (!/^[a-z0-9-]{1,64}$/.test(id ?? '')) {
      const err = new Error('template_invalid');
      err.code = 'template_invalid';
      throw err;
    }
    const base = CATALOGO[id];
    if (!base) {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    template = base;
  }
  const ses = acunar(template);
  process.stdout.write(`${JSON.stringify(ses, null, 2)}\n`);
  return 0;
}
