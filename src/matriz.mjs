// Matriz de configuración v1 — carga glosomata.json y valida disponibilidad.
// Contrato: docs/specs/specs-y-contratos-v1.md (§ matriz)

import { readFile } from 'node:fs/promises';

const RUTA_CONFIG = process.env.GLOSOMATA_CONFIG ?? 'glosomata.json';

const PROBES = {
  say: (e) => import('./tts/say.mjs').then((m) => m.diagnostico(e)),
  piper: (e) => import('./tts/piper.mjs').then((m) => m.diagnostico(e)),
  kokoro: (e) => import('./tts/kokoro.mjs').then((m) => m.diagnostico(e)),
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
  // reventaba con TypeError fuera de la taxonomía (ronda 5, M-6);
  // entradas no-objeto en tts[] revientaban el loop de probes igual
  // (doctor las etiquetaba config_unreadable con detalle "undefined")
  if (typeof cfg !== 'object' || cfg === null
      || !Array.isArray(cfg.engines?.tts)
      || typeof cfg.engines?.stt !== 'object' || cfg.engines.stt === null
      || cfg.engines.tts.some((x) => !x || typeof x !== 'object')) {
    throw errConfig('estructura inválida: engines.tts[] y engines.stt{} requeridos');
  }
  for (const e of cfg.engines.tts) {
    // fail-closed: sin kill_switch declarado, el motor no es seleccionable
    if (!e.kill_switch?.type || !e.kill_switch?.max_latency_ms) {
      e.available = false;
      e.causa = 'sin_kill_switch'; // cerrado, para doctor (C0.2)
      continue;
    }
    const probe = PROBES[e.adapter];
    const d = probe
      ? await probe(e).catch(() => ({ ok: false, causa: 'probe_fallido' }))
      : { ok: false, causa: 'adapter_desconocido' };
    e.available = d.ok;
    if (!d.ok) e.causa = d.causa;
  }
  return cfg;
}

// Lectura cruda (P1.1): JSON tal cual en disco, SIN probes ni campos
// derivados — `config list/get` muestra lo que HAY; validar es
// `config validate` (P1.3), la lectura no juzga.
export async function leerConfigCruda(ruta = RUTA_CONFIG) {
  try {
    return JSON.parse(await readFile(ruta, 'utf8'));
  } catch {
    throw errConfig(`ilegible: ${ruta}`);
  }
}

// Secciones cerradas, sin traversal (misma regla que templates --show)
const SECCIONES = new Set(['engines', 'constraints']);

// P1.3: validación completa — estructura (schema P0.2) + probes +
// kill_switch — sobre la MISMA ruta que usará config set. Veredicto
// estilo doctor: JSON por stdout, stderr vacío, exit 0 sólo si todo
// lo DECLARADO pasa (stt sin claves declaradas no invalida: es
// no-disponible fail-closed, no config rota).
export async function validarConfig(ruta = RUTA_CONFIG) {
  const veredicto = { estructura: [], motores: null, stt: null };

  let cfg;
  try {
    cfg = JSON.parse(await readFile(ruta, 'utf8'));
  } catch {
    veredicto.estructura.push(`JSON ilegible: ${ruta}`);
    return { code: 1, data: veredicto };
  }

  // estructura: el schema formal es ley; sin él, fallo explícito
  const { validar } = await import('./schema.mjs');
  let schema;
  try {
    schema = JSON.parse(await readFile(
      new URL('../docs/schemas/glosomata-config-v1.schema.json',
        import.meta.url), 'utf8'));
  } catch {
    const err = new Error('internal_error');
    err.code = 'internal_error';
    err.cause = 'schema formal ausente o ilegible';
    throw err;
  }
  veredicto.estructura = validar(cfg, schema);
  if (veredicto.estructura.length > 0) {
    return { code: 1, data: veredicto };
  }

  // probes + kill_switch (cargarMatriz ya fail-closed con causas)
  const sondeada = await cargarMatriz(ruta);
  veredicto.motores = sondeada.engines.tts.map((e) => ({
    id: e.id, adapter: e.adapter, available: !!e.available,
    ...(e.available ? {} : { causa: e.causa ?? 'probe_fallido' }),
  }));
  const sttDeclarado = !!(sondeada.engines.stt?.whisper_bin
    || sondeada.engines.stt?.whisper_model);
  const { diagnosticoWhisper } = await import('./stt.mjs');
  const whisper = await diagnosticoWhisper(sondeada);
  veredicto.stt = {
    declarado: sttDeclarado, available: whisper.ok,
    ...(whisper.ok ? {} : { causa: whisper.causa }),
  };
  const ok = veredicto.motores.every((m) => m.available)
    && (!sttDeclarado || whisper.ok);
  return { code: ok ? 0 : 1, data: veredicto };
}

// —— datos (nunca imprimen) ——
export async function configData(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'list') {
    if (rest.length > 0) return { code: 2, data: { error: 'usage' } };
    return { code: 0, data: await leerConfigCruda() };
  }
  if (sub === 'get') {
    const seccion = rest[0];
    if (rest.length !== 1 || !SECCIONES.has(seccion)) {
      return { code: 2, data: { error: 'usage' } };
    }
    const cfg = await leerConfigCruda();
    return { code: 0, data: cfg[seccion] ?? null };
  }
  if (sub === 'validate') {
    const i = rest.indexOf('--file');
    let ruta = RUTA_CONFIG;
    if (i >= 0) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--') || rest.length !== 2) {
        return { code: 2, data: { error: 'usage' } };
      }
      ruta = v;
    } else if (rest.length > 0) {
      return { code: 2, data: { error: 'usage' } };
    }
    return validarConfig(ruta);
  }
  return { code: 2, data: { error: 'usage' } };
}
