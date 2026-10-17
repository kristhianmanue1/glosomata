// Matriz de configuración v1 — carga glosomata.json y valida disponibilidad.
// Contrato: docs/specs/specs-y-contratos-v1.md (§ matriz)

import { readFile, writeFile, mkdir, readdir, rm, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';

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
  // semántica de matriz (P1.2): ids únicos y exactamente un selected
  // (el schema no puede expresarlo; config validate y config set
  // comparten la misma barrera)
  if (veredicto.estructura.length === 0) {
    const ids = cfg.engines.tts.map((e) => e.id);
    const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    if (dup.length > 0) {
      veredicto.estructura.push(`ids duplicados en engines.tts: ${dup.join(', ')}`);
    }
    const nSel = cfg.engines.tts.filter((e) => e.selected === true).length;
    if (nSel !== 1) {
      veredicto.estructura.push(`selected: exactamente 1 motor en true (hay ${nSel})`);
    }
    if (veredicto.estructura.length > 0) {
      return { code: 1, data: veredicto };
    }
  } else {
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

const rand6 = () => Math.random().toString(36).slice(2, 8);
const fechaCompacta = () => new Date().toISOString()
  .replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// P1.2: config set — replace atómico de la matriz COMPLETA (sin
// parches por clave). El candidato se copia a un temporal 0600 EN el
// directorio del destino (rename atómico exige mismo filesystem), se
// valida TODO sobre el temporal (estructura + semántica + probes) y
// sólo entonces: backup del actual → rename. Cualquier fallo deja el
// original intacto y responde config_write_failed con el veredicto.
// El schema (additionalProperties:false) garantiza que jamás se
// persistan campos derivados (available/causa): un candidato que los
// traiga es rechazado.
export async function escribirConfig(rutaCandidata, destino = RUTA_CONFIG) {
  let contenido;
  try {
    contenido = await readFile(rutaCandidata, 'utf8');
  } catch {
    return { code: 1, data: { error: 'config_write_failed',
      estructura: [`candidato ilegible: ${rutaCandidata}`] } };
  }
  const tmp = join(dirname(destino),
    `.glosomata-set-${process.pid}-${rand6()}.tmp`);
  try {
    await writeFile(tmp, contenido, { mode: 0o600 });
    const v = await validarConfig(tmp);
    if (v.code !== 0) {
      return { code: 1, data: { error: 'config_write_failed',
        estructura: v.data.estructura, motores: v.data.motores,
        stt: v.data.stt } };
    }
    // backup del actual (si existe): junto al lock, 0600, últimas 5
    const { rutaBackups } = await import('./canal.mjs');
    const bdir = rutaBackups();
    await mkdir(bdir, { recursive: true, mode: 0o700 });
    let actual = null;
    try {
      actual = await readFile(destino);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e; // sin actual: sin backup
    }
    let backup = null;
    if (actual !== null) {
      backup = `glosomata-${fechaCompacta()}-${rand6()}.json`;
      await writeFile(join(bdir, backup), actual, { mode: 0o600 });
    }
    const entradas = (await readdir(bdir))
      .filter((f) => f.startsWith('glosomata-') && f.endsWith('.json'))
      .sort();
    for (const vieja of entradas.slice(0, -5)) {
      await rm(join(bdir, vieja), { force: true });
    }
    await rename(tmp, destino);
    return { code: 0, data: { ok: true,
      ...(backup ? { backup } : {}), motores: v.data.motores,
      stt: v.data.stt } };
  } catch (e) {
    return { code: 1, data: { error: 'config_write_failed',
      causa: String(e.code ?? e.message) } };
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

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
  if (sub === 'set') {
    const rutaCand = rest[0];
    if (rest.length !== 1 || !rutaCand || rutaCand.startsWith('--')) {
      return { code: 2, data: { error: 'usage' } };
    }
    return escribirConfig(rutaCand);
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
