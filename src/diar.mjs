// Motor de diarización (ADR-012): probe estructural (D1) y operación
// `diarize` (D2). Contrato: docs/specs/contrato-diarizacion-v1.md.
// La operación NO toma el canal (no captura ni reproduce audio) y
// NUNCA escribe artefactos: lee la ruta del consumidor, infiere por
// subprocess y devuelve turnos.

import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  spawnGrupo, matarGrupo, resetStop, stopGeneration, stopPedido,
  registrarEspera, liberarEspera,
} from './canal.mjs';
import { measureOperation } from './duration.mjs';
import { cargarMatriz } from './matriz.mjs';

// —— D1: probe ESTRUCTURAL, sin ejecutar nada ——

// engines.diar ausente → null (NO declarado: no es defecto, la
// superficie responde not_supported). Declarado → {ok, causa?} con el
// conjunto cerrado del contrato §7: python_ausente |
// script_ausente | pesos_ausentes | probe_fallido.
//
// `pipeline` es el espejo LOCAL de pyannote
// speaker-diarization-community-1: un DIRECTORIO con config.yaml (la
// firma estructural mínima que Pipeline.from_pretrained exige para
// cargar sin red — ADR-012: glosomata jamás descarga pesos). El
// python apunta al venv SEPARADO (torch/torchcodec no intoxican el
// venv de kokoro/piper). Rutas relativas contra el CWD del proceso
// (regla transversal de la guía). Sin base para especular causas más
// finas: el chequeo es de existencia/estructura, no de ejecución.
export async function diagnosticoDiar(cfg) {
  const d = cfg?.engines?.diar;
  if (d === undefined) return null;
  const forma = (v) => typeof v === 'string' && v.length > 0;
  // config editada a mano (sin schema de por medio): fail-closed sin
  // atribuir 'ausente' a lo que ni forma tiene
  if (d === null || typeof d !== 'object'
      || !forma(d.python) || !forma(d.script) || !forma(d.pipeline)) {
    return { ok: false, causa: 'probe_fallido' };
  }
  try {
    await access(d.python, constants.F_OK);
  } catch {
    return { ok: false, causa: 'python_ausente' };
  }
  try {
    await access(d.script, constants.F_OK);
  } catch {
    return { ok: false, causa: 'script_ausente' };
  }
  try {
    const st = await stat(d.pipeline);
    if (!st.isDirectory()) return { ok: false, causa: 'pesos_ausentes' };
    await access(join(d.pipeline, 'config.yaml'), constants.F_OK);
  } catch {
    return { ok: false, causa: 'pesos_ausentes' };
  }
  return { ok: true };
}

// —— D2: operación diarize ——

const DEFAULT_MAX_DUR_S = 14400; // contrato §6 (diar_max_duration_s)
const DEFAULT_MAX_WALL_S = 7200; // contrato §6 (diar_max_wall_s)
const TOPE_STDOUT = 16 * 1024 * 1024; // 16 MiB, como phonon/lfm3

// Exit codes del script Python (contrato §4): 0 ok; 3 audio_ilegible;
// 4 audio_demasiado_largo; 2 mal uso del propio script (incluido env
// del subprocess sin las dos variables exigidas); otro →
// inferencia_fallida.
function causaPorExit(code) {
  if (code === 3) return 'audio_ilegible';
  if (code === 4) return 'audio_demasiado_largo';
  return 'inferencia_fallida';
}

// Canonización (contrato §2): orden por start_s, etiquetas OPACAS
// renombradas por PRIMERA APARICIÓN EN ORDEN TEMPORAL (las crudas del
// motor jamás salen), precisión de milésimas, sin solapes. Cualquier
// violación de forma → null (fail-closed: sin resultado parcial).
export function canonizarTurnos(turns) {
  if (!Array.isArray(turns)) return null;
  const redondear = (x) => Math.round(x * 1000) / 1000;
  const validos = [];
  for (const t of turns) {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return null;
    if (typeof t.speaker !== 'string' || t.speaker.length === 0) return null;
    const { start_s, end_s } = t;
    if (!Number.isFinite(start_s) || !Number.isFinite(end_s)) return null;
    if (start_s < 0 || end_s <= start_s) return null;
    validos.push({ speaker: t.speaker,
      start_s: redondear(start_s), end_s: redondear(end_s) });
  }
  validos.sort((a, b) => a.start_s - b.start_s || a.end_s - b.end_s);
  for (let i = 1; i < validos.length; i++) {
    if (validos[i - 1].end_s > validos[i].start_s) return null; // solape
  }
  // el redondeo a milésimas es monótono (no crea solapes) pero puede
  // COLAPSAR un turno sub-milisegundo a end == start (hallazgo H-2,
  // ronda r1): re-chequeo tras redondear, fail-closed
  for (const t of validos) {
    if (t.end_s <= t.start_s) return null;
  }
  const etiquetas = new Map();
  const out = validos.map((t) => {
    if (!etiquetas.has(t.speaker)) {
      etiquetas.set(t.speaker,
        `SPEAKER_${String(etiquetas.size).padStart(2, '0')}`);
    }
    return { speaker: etiquetas.get(t.speaker),
      start_s: t.start_s, end_s: t.end_s };
  });
  // `etiquetas` (cruda → canónica) alimenta la re-llave de las huellas
  // (enmienda 2026-11-17); el llamador NO lo copia a la salida.
  return { turns: out, num_speakers: etiquetas.size, etiquetas };
}

// Huellas de voz (enmienda 2026-11-17, ADR-012): el script emite el
// centroide por hablante CRUDO {etiqueta: [floats]}; glosomata
// re-llavea por etiqueta CANÓNICA. Cobertura EXACTA (toda etiqueta
// con turno debe tener huella; sin sobrantes), vectores de números
// finitos no vacíos y dimensión homogénea — cualquier violación →
// null (fail-closed: sin resultado parcial). Dato biométrico: vive
// SOLO en la respuesta por stdout (contrato §8).
const EMBEDDING_MODEL = 'speaker-diarization-community-1#embedding';

function canonizarHuellas(embCrudo, etiquetas) {
  if (embCrudo === null || typeof embCrudo !== 'object'
      || Array.isArray(embCrudo)) return null;
  const crudas = [...etiquetas.keys()];
  const claves = Object.keys(embCrudo);
  if (claves.length !== crudas.length
      || !crudas.every((c) => Object.prototype.hasOwnProperty
        .call(embCrudo, c))) {
    return null;
  }
  let dim = null;
  const speakers = {};
  for (const [cruda, canonica] of etiquetas) {
    const v = embCrudo[cruda];
    if (!Array.isArray(v) || v.length === 0) return null;
    if (!v.every((x) => Number.isFinite(x))) return null;
    // artefacto de padding del motor (vector de puros ceros, H4 r1):
    // norma 0 = huella no emparejable (coseno indefinido) — fail-closed
    if (v.every((x) => x === 0)) return null;
    if (dim === null) dim = v.length;
    else if (v.length !== dim) return null;
    speakers[canonica] = { embedding: v, dim: v.length };
  }
  return { speakers, embedding_model: EMBEDDING_MODEL };
}

// Superficie ESTRICTA (contrato §2): `--file <valor>` y, opcional,
// el flag sin valor `--embeddings` (enmienda 2026-11-17) — a lo sumo
// una vez y en cualquiera de las dos posiciones admitidas.
function parsearArgvDiarize(argv) {
  const sinHuellas = argv.length === 2 && argv[0] === '--file';
  const conHuellasA = argv.length === 3 && argv[0] === '--file'
    && argv[2] === '--embeddings';
  const conHuellasB = argv.length === 3 && argv[0] === '--embeddings'
    && argv[1] === '--file';
  if (!sinHuellas && !conHuellasA && !conHuellasB) return null;
  const ruta = conHuellasB ? argv[2] : argv[1];
  if (ruta === '' || ruta.startsWith('--')) return null;
  return { ruta, huellas: !sinHuellas };
}

export async function diarize(argv, stopAtStart = stopGeneration(), opts = {}) {
  return measureOperation(() => diarizeRaw(argv, stopAtStart, opts));
}

async function diarizeRaw(argv, stopAtStart, opts = {}) {
  const parsed = parsearArgvDiarize(argv);
  if (parsed === null) {
    return { code: 2, data: { error: 'usage' } };
  }
  const { ruta: rutaAudio, huellas } = parsed;
  const cfg = await cargarMatriz();
  const d = cfg.engines?.diar;
  if (d === undefined) {
    // capacidad no configurada: fail-closed, sin default oculto
    return { code: 1, data: { error: 'not_supported' } };
  }
  // re-chequeo estructural en cada apertura (como listen con ffmpeg)
  const probe = await diagnosticoDiar(cfg);
  if (probe !== null && !probe.ok) {
    return { code: 1, data: { error: 'diar_failed', causa: probe.causa } };
  }
  const maxDurS = Number.isFinite(cfg.constraints?.diar_max_duration_s)
    ? cfg.constraints.diar_max_duration_s : DEFAULT_MAX_DUR_S;
  const maxWallS = Number.isFinite(cfg.constraints?.diar_max_wall_s)
    ? cfg.constraints.diar_max_wall_s : DEFAULT_MAX_WALL_S;

  // H-2 (issue #43): registro como esperador para que `stop` de OTRO
  // proceso alcance esta operación aunque no tome canal.lock — la
  // orden llega por el socket con acuse (canal.mjs). Sin registro el
  // stop remoto no llegaría: fail-closed, la operación falla.
  let stopRemoto = false;
  let registro = null;
  try {
    registro = await registrarEspera(() => { stopRemoto = true; });
  } catch {
    return { code: 1, data: { error: 'internal_error' } };
  }
  resetStop(stopAtStart);
  try {
    const r = await correrDiarizacion(d, rutaAudio, maxDurS, maxWallS,
      huellas, () => stopPedido() || stopRemoto);
    if (r.detenido) {
      // stop/señal: truncado espejo de speak — stdout, stderr vacío
      return { code: 1, data: { turns: null, truncated: true } };
    }
    if (r.timeout) {
      return { code: 1, data: { error: 'diar_failed',
        causa: 'timeout_inferencia' } };
    }
    if (r.exitCode !== 0) {
      return { code: 1, data: { error: 'diar_failed',
        causa: causaPorExit(r.exitCode) } };
    }
    if (r.stdout.length > TOPE_STDOUT) {
      return { code: 1, data: { error: 'diar_failed',
        causa: 'inferencia_fallida' } };
    }
    let crudo;
    try {
      crudo = JSON.parse(r.stdout);
    } catch {
      return { code: 1, data: { error: 'diar_failed',
        causa: 'inferencia_fallida' } };
    }
    const canon = canonizarTurnos(crudo?.turns);
    if (canon === null) {
      return { code: 1, data: { error: 'diar_failed',
        causa: 'inferencia_fallida' } };
    }
    const data = { turns: canon.turns, num_speakers: canon.num_speakers,
      mode: 'exclusive' };
    if (huellas) {
      // enmienda 2026-11-17: huellas sólo si se pidieron — sin el
      // flag, la salida es idéntica byte a byte (contrato §2)
      const huellasCanon = canonizarHuellas(crudo?.embeddings,
        canon.etiquetas);
      if (huellasCanon === null) {
        return { code: 1, data: { error: 'diar_failed',
          causa: 'inferencia_fallida' } };
      }
      data.speakers = huellasCanon.speakers;
      data.embedding_model = huellasCanon.embedding_model;
    }
    return { code: 0, data };
  } finally {
    await liberarEspera(registro);
  }
}

function correrDiarizacion(d, rutaAudio, maxDurS, maxWallS, huellas,
  detenido) {
  return new Promise((resolve) => {
    // Entorno del subprocess FIJADO (contrato §4, ADR-012): telemetría
    // OFF y sin red, SIN importar el ambiente del padre — argv sin
    // contenido: sólo rutas, el tope de duración (H-1: el límite
    // configurable viaja al script como 5º token) y el modo de
    // huellas como 6º (enmienda 2026-11-17).
    const child = spawnGrupo(d.python,
      [d.script, d.pipeline, rutaAudio, String(maxDurS),
        huellas ? '1' : '0'],
      { env: { ...process.env,
        PYANNOTE_METRICS_ENABLED: '0', HF_HUB_OFFLINE: '1' } });
    child.stdin.end(); // stdin cerrado: EOF limpio para el hijo
    let stdout = '';
    let timeout = false;
    const wall = setTimeout(() => {
      timeout = true; // tope EVALUADO: SIGKILL al grupo (contrato §3.1)
      matarGrupo(child);
    }, maxWallS * 1000);
    const poll = setInterval(() => {
      if (detenido()) matarGrupo(child);
    }, 50);
    child.stdout.on('data', (x) => {
      // cota de memoria en unidades UTF-16 (equivalente aproximada
      // del tope en bytes para el JSON del motor; hallazgo H-6 r1:
      // declarado, no convertido): lo que excede se descarta y falla
      if (stdout.length <= TOPE_STDOUT) stdout += x.toString();
    });
    child.on('error', () => {
      // spawn roto (python borrado entre probe y exec): fail-closed
      clearInterval(poll);
      clearTimeout(wall);
      resolve({ exitCode: -1, stdout: '', detenido: false, timeout: false });
    });
    child.on('close', (exitCode) => {
      clearInterval(poll);
      clearTimeout(wall);
      // SIGKILL de stop y close compiten: el estado gana (stt.mjs M-1)
      resolve({ exitCode: exitCode ?? -1, stdout,
        detenido: !timeout && detenido(), timeout });
    });
  });
}
