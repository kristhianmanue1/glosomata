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
  const r = await sessionData(argv);
  process.stdout.write(`${JSON.stringify(r.data, null, 2)}\n`);
  return r.code;
}

export async function sessionData(argv) {
  const [sub, ...rest] = argv;
  if (sub !== 'new') return { code: 2, data: { error: 'usage' } };
  const tIdx = rest.indexOf('--template');
  let template = null;
  if (tIdx >= 0) {
    const id = rest[tIdx + 1];
    if (!/^[a-z0-9-]{1,64}$/.test(id ?? '')) {
      return { code: 1, data: { error: 'template_invalid' } };
    }
    const base = CATALOGO[id];
    if (!base) return { code: 1, data: { error: 'not_found' } };
    template = base;
  }
  const ses = acunar(template);
  return { code: 0, data: ses };
}
