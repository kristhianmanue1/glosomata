// Operaciones del canal: retornan {code, data}; NUNCA escriben stdout.
// Presentación: cli-core imprime; mcp-core envuelve en JSON-RPC. (Fix
// BLOCKER ronda 3: contaminación del protocolo MCP.)

import { cargarMatriz } from './matriz.mjs';
import { canonizar } from './plantillas.mjs';
import { rutaFfmpeg, diagnosticoCaptura, diagnosticoWhisper } from './stt.mjs';
import {
  adquirirCanal, liberarCanal, resetStop, stopGeneration, stopPedido,
  detenerCanalRemoto, nuevoTemporal, registrarEspera, liberarEspera,
} from './canal.mjs';
import { rm } from 'node:fs/promises';
import { measureOperation } from './duration.mjs';

// Sólo afplay en los adaptadores emite audio_device_error: una falla
// allí sí acredita playback_failed. tts_failed no identifica la etapa.
export function ttsAudioCause(code) {
  return code === 'audio_device_error' ? 'playback_failed' : null;
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

// Lectura de stdin para --text-stdin (UTF-8) con COTA EN STREAMING y
// cancelación coherente con stop (corrección r2, hallazgo 1 de la
// revisión). TTY (sin tubería) → entrada vacía cruda (fail-closed:
// nunca se cuelga esperando una terminal interactiva). Un error de
// lectura NO es entrada vacía (r4, H-3): marca propia errorLectura y
// el llamador responde internal_error sin hablar parcial alguno.
//
// CONTRATO (contraejemplo de la revisión r2bis): la cota usa la MISMA
// métrica que canonizar (NFC + eliminación de inaudibles), no la
// longitud cruda — 2001 crudos con U+200B canonizan a 2000 y 2000 pares
// a+U+0301 canonizan a 1000: ambos los acepta --text y --text-stdin
// debe aceptarlos también. Fundamento: (1) NFC(NFC(s)⊕t) == NFC(s⊕t)
// (la equivalencia canónica es congruencia de concatenación), así que
// acumular re-normalizando por segmentos reproduce canonizar exacto;
// (2) la longitud canonizada es monótona no-decreciente al añadir
// caracteres, así que rechazar cuando el acumulado canonizado excede
// `maxChars` es sound sin esperar EOF y sin falsos rechazos; (3) los
// inaudibles son inertes para NFC salvo como BARRERA de composición
// (una racha bloquea lo mismo que un representante) y canonizar los
// elimina antes de medir: podar cada racha a un representante (la
// inicial, a cero) mantiene el resultado idéntico con memoria acotada
// aunque el texto crudo sea arbitrario. La equivalencia la fijan los
// tests de tests/cli.test.mjs contra canonizar.
// Stop: si llega una señal de stop (SIGINT cross-process o intra-proceso)
// durante la espera — incluso con el pipe abierto en silencio, que sólo
// el intervalo detecta — la lectura aborta como `detenido` sin hablar.
//
// DRENAJE (r3, B2): con motor ausente el llamador pide `drenar: true` —
// no se acumula ni se acota (memoria constante); sólo se determina la
// vacuidad CRUDA (la misma métrica de `--text`: !args.text) y el stop.
// Así la precedencia de errores es idéntica a `--text`: el vacío responde
// `usage`, cualquier texto no vacío `engine_unavailable`, y `text_too_long`
// nunca decide sin motor (canonizar no se evalúa sin motor en `--text`).
//
// VACÍO (r4, H-2): `vacio` es la métrica CRUDA — llegó algún carácter,
// antes de canonizar — en AMBOS modos: es la métrica de `--text`
// (!args.text). Una entrada de sólo inaudibles NO es vacía: decide
// `usage` sólo el crudo vacío, y el sólo-inaudibles sigue el mismo
// camino que --text '<inaudibles>' (habla el vacío canonizado).

// Espejo del INAUDIBLES de canonizar (plantillas.mjs, fuera de alcance
// de esta corrección): mismos rangos, verificados por los tests.
const RANGOS_INAUDIBLES = '\\u200B-\\u200D\\uFEFF\\u202A-\\u202E'
  + '\\u0000-\\u0008\\u000B-\\u001F';
const RE_INAUDIBLE = new RegExp(`[${RANGOS_INAUDIBLES}]`, 'g');
const RE_RACHA_INAUDIBLE = new RegExp(`[${RANGOS_INAUDIBLES}]+`, 'g');
const SEGMENTO_NFC = 2048;

// Racha inicial → cero (a su izquierda no hay nada que bloquear);
// rachas interiores/finales → un representante (barrera de composición).
function podarRachas(acc) {
  return acc.replace(RE_RACHA_INAUDIBLE,
    (racha, offset) => (offset === 0 ? '' : racha[0]));
}

export function leerStdin(stdin = process.stdin,
  { maxChars = 2000, parar = stopPedido, intervaloMs = 50,
    drenar = false } = {}) {
  return new Promise((resolve) => {
    if (stdin.isTTY) {
      return resolve(drenar ? { vacio: true } : { texto: '', vacio: true });
    }
    let terminado = false;
    let acc = ''; // NFC acumulado, inaudibles podados a 1 por racha
    let vacio = true; // métrica cruda: llegó algún carácter (r4, H-2)
    let poll = null;
    const cerrar = (resultado, destruir = false) => {
      if (terminado) return;
      terminado = true;
      if (poll) clearInterval(poll);
      if (destruir) stdin.destroy();
      resolve(resultado);
    };
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => {
      if (terminado) return;
      if (c.length > 0) vacio = false; // crudo, antes de canonizar
      if (drenar) {
        if (parar()) return cerrar({ detenido: true }, true);
        return;
      }
      // segmentos acotados (sin partir pares sustituto): la memoria
      // transitoria no depende del tamaño del chunk recibido
      for (let i = 0; i < c.length;) {
        let fin = Math.min(i + SEGMENTO_NFC, c.length);
        if (fin < c.length) {
          const prev = c.charCodeAt(fin - 1);
          if (prev >= 0xD800 && prev <= 0xDBFF) fin -= 1;
        }
        acc = podarRachas(
          (acc + c.slice(i, fin)).normalize('NFC'));
        i = fin;
        if (acc.replace(RE_INAUDIBLE, '').length > maxChars) {
          return cerrar({ excedido: true }, true);
        }
        if (parar()) return cerrar({ detenido: true }, true);
      }
    });
    stdin.on('end', () => cerrar(
      drenar ? { vacio } : { texto: acc.replace(RE_INAUDIBLE, ''), vacio }));
    // error de lectura: marca propia, sin texto parcial (r4, H-3)
    stdin.on('error', () => cerrar({ errorLectura: true }, true));
    // pipe abierto en silencio: sólo el intervalo detecta el stop
    poll = setInterval(() => {
      if (parar()) cerrar({ detenido: true }, true);
    }, intervaloMs);
  });
}

// Parser estricto de speak: separa la bandera --text-stdin con
// multiplicidad EXACTAMENTE uno (corrección r2, hallazgo 4: el filtrado
// a ciegas aceptaba duplicados y dejaba a la bandera actuar como valor).
// El resto va íntegro a parseArgs v1: opciones conocidas, valores
// obligatorios que no inician con '--'. Duplicada → null → usage.
function partirArgvSpeak(argv) {
  let usaStdin = false;
  const resto = [];
  for (const token of argv) {
    if (token === '--text-stdin') {
      if (usaStdin) return null;
      usaStdin = true;
      continue;
    }
    resto.push(token);
  }
  return { usaStdin, resto };
}

// Resolución del motor compartida por ambas superficies: la
// disponibilidad se decide ANTES de canonizar/leer (r3, B2 — precedencia
// de errores idéntica a `--text`: engine_unavailable gana a
// text_too_long cuando ambos fallarían).
function resolverMotor(cfg, args) {
  if (args.engine) {
    const motor = cfg.engines.tts.find((e) => e.id === args.engine);
    return motor?.available ? motor : null;
  }
  return cfg.engines.tts.find((e) => e.selected && e.available) ?? null;
}

export async function speakOp(argv, stdin = process.stdin) {
  const stopAtStart = stopGeneration();
  return measureOperation(async () => {
    const parted = partirArgvSpeak(argv);
    const args = parted === null
      ? null
      : parseArgs(parted.resto, { '--text': 'text', '--engine': 'engine' });
    if (parted === null || args === null) {
      return { code: 2, data: { error: 'usage' } };
    }
    if (!parted.usaStdin) {
      return !args.text
        ? { code: 2, data: { error: 'usage' } }
        : speakRaw(args, stopAtStart);
    }
    // --text-stdin: exclusión mutua con --text; el tope de la matriz se
    // aplica DURANTE la lectura (no tras EOF). Config ilegible → fallo
    // inmediato, sin esperar el pipe.
    if (args.text !== undefined) {
      return { code: 2, data: { error: 'usage' } };
    }
    const cfg = await cargarMatriz();
    const maxChars = cfg.constraints?.max_text_chars ?? 2000;
    // Disponibilidad del motor ANTES de la cota (r3, B2): sin motor la
    // lectura DRENA — al EOF, vacío → usage, texto no vacío →
    // engine_unavailable; `text_too_long` sólo decide con motor
    // disponible (rechazo temprano conservado).
    const motorDisponible = resolverMotor(cfg, args) !== null;
    // Registro como esperador para el stop cross-process (r3, B1; r4,
    // H-5: socket propio con acuse — jamás señal a un pid ajeno): aún
    // sin canal, `stop` de otro proceso alcanza a este proceso durante
    // la lectura. Sin registro la espera sería ininterrumpible de forma
    // remota: fail-closed — si el registro falla, la operación falla.
    let registro = null;
    try {
      let stopRemoto = false;
      registro = await registrarEspera(() => { stopRemoto = true; });
      const leido = await leerStdin(stdin, {
        maxChars, drenar: !motorDisponible,
        parar: () => stopPedido() || stopRemoto,
      });
      if (leido.detenido) {
        // stop durante la espera: mismo truncado del stop en reproducción
        // ('stopped' es sólo de listen); no se habla ni se toma el canal.
        return { code: 1, data: { played: false, echo: null, truncated: true } };
      }
      // error de lectura de stdin NO es entrada vacía (r4, H-3): código
      // existente de la taxonomía, sin hablar el parcial leído.
      if (leido.errorLectura) {
        return { code: 1, data: { error: 'internal_error' } };
      }
      if (!motorDisponible) {
        return leido.vacio
          ? { code: 2, data: { error: 'usage' } }
          : { code: 1, data: { error: 'engine_unavailable' } };
      }
      if (leido.excedido) return { code: 1, data: { error: 'text_too_long' } };
      // Vacío por MÉTRICA CRUDA (r4, H-2): misma regla que --text
      // (!args.text sobre el crudo). Un stdin de sólo inaudibles no es
      // vacío: habla el vacío canonizado, igual que --text '<inaudibles>'.
      return leido.vacio
        ? { code: 2, data: { error: 'usage' } }
        : speakRaw({ ...args, text: leido.texto }, stopAtStart);
    } finally {
      await liberarEspera(registro);
    }
  });
}

// Núcleo de speak con objeto directo {text, engine?}. MCP inyecta aquí:
// re-serializar a argv re-parseaba y rechazaba texto legítimo que inicia
// con '--' como usage falso (ronda 5, M-5).
export async function speakCore(args, stopAtStart = stopGeneration()) {
  return measureOperation(() => speakRaw(args, stopAtStart));
}

async function speakRaw(args, stopAtStart) {
  const cfg = await cargarMatriz();
  const motor = resolverMotor(cfg, args);
  if (!motor) {
    return { code: 1, data: { error: 'engine_unavailable' } };
  }
  let texto;
  try {
    texto = canonizar(args.text, cfg.constraints?.max_text_chars ?? 2000);
  } catch (e) {
    return { code: 1, data: { error: e.code } };
  }
  await adquirirCanal();
  resetStop(stopAtStart);
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
    const audioCause = ttsAudioCause(e.code);
    return { code: 1, data: { error: e.code ?? 'internal_error',
      ...(audioCause ? { causa: audioCause } : {}) } };
  } finally {
    if (tmpWav) await rm(tmpWav, { force: true }).catch(() => {});
    await liberarCanal();
  }
}

export async function listenOp(argv, stopAtStart = stopGeneration()) {
  const { listen } = await import('./stt.mjs');
  return listen(argv, stopAtStart);
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
  const tts = cfg.engines.tts.map((e) => ({
    id: e.id, adapter: e.adapter, available: e.available,
    selected: e.selected && e.available,
  }));
  // STT curado como TTS: disponibilidad, no rutas del filesystem
  // (ronda 5: exponía whisper_bin/whisper_model al consumidor MCP)
  const sttOk = (await diagnosticoWhisper(cfg)).ok;
  return { code: 0, data: { tts, stt: { available: sttOk } } };
}

// Diagnóstico de adopción (doctor, C0.2): checks cerrados, causas del
// conjunto cerrado de los adaptadores (contrato de consumo §7.1).
// Salida contractual por stdout; exit 0 sólo si TODO está operativo.
export async function doctorOp() {
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

  const ffmpeg = await diagnosticoCaptura();
  const whisper = cfg
    ? await diagnosticoWhisper(cfg)
    : { ok: false, causa: 'config_unreadable' };

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
export async function speakMcp(args, stopAtStart = stopGeneration()) {
  if (typeof args?.text !== 'string' || !args.text) {
    return measureOperation(() => ({ code: 2, data: { error: 'usage' } }));
  }
  return speakCore(args, stopAtStart);
}

export async function configOp(argv) {
  const { configData } = await import('./matriz.mjs');
  return configData(argv);
}
