// Inventario de dispositivos de audio del HOST LOCAL — sólo lectura.
// NO abre el canal (sin canal.lock), NO abre micrófono ni reproduce:
// las dos fuentes del listado son sondas que no tocan dispositivos
// (contrato: docs/specs/contrato-hardware-v1.md).
//
// Dos fuentes independientes con degradación honesta:
//   1. ffmpeg -list_devices (avfoundation): entradas con índice de
//      backend. OBSERVADO: el proceso termina con exit I/O error
//      DESPUÉS de listar — la decisión es por CONTENIDO, nunca por exit.
//   2. system_profiler SPAudioDataType: defaults del SO (entrada y
//      salida) por flags coreaudio_default_*; el default de ENTRADA del
//      SO se marca además sobre las entradas de ffmpeg por match de
//      nombre (best-effort: homónimos posibles, residual declarado).
//
// Retención: ids/nombres/flags/marca de tiempo. JAMÁS audio ni texto.

import { spawn } from 'node:child_process';
import { rutaFfmpeg } from './stt.mjs';

const TIMEOUT_MS = 10_000;
const TOPE_SALIDA = 200_000;

// Ruta del binario system_profiler (overridable para tests herméticos;
// variable documentada en contrato-hardware-v1.md §6 y
// contrato-consumo-agentes-v1.md §6).
function rutaSystemProfiler() {
  return process.env.GLOSOMATA_SYSTEM_PROFILER ?? '/usr/sbin/system_profiler';
}

// Parser puro del listado avfoundation de ffmpeg: extrae SÓLO la sección
// de dispositivos de AUDIO (glosomata es audio por contrato; el vídeo se
// ignora). Formato observado: CADA línea lleva prefijo de log
// `[AVFoundation indev @ 0x...]`, seguido del dispositivo `[n] nombre`.
// El prefijo es opcional en el parser (anclado a inicio de línea para
// que las líneas de error de ffmpeg, p.ej. `[in#0 @ ...] Error...`,
// jamás parseen como dispositivos). Ilegible o vacío → null
// (fail-closed), jamás throw.
const RE_SECCION = /avfoundation\s+(audio|video)\s+devices\s*:/i;
const RE_DISPOSITIVO = /^\s*(?:\[[^\]]*\]\s*)?\[\s*(\d+)\s*\]\s*(.+?)\s*$/;

export function parseListadoFfmpeg(texto) {
  if (typeof texto !== 'string' || texto.length === 0) return null;
  let enAudio = false;
  let seccionVista = false;
  const dispositivos = [];
  for (const linea of texto.split(/\r?\n/)) {
    const seccion = linea.match(RE_SECCION);
    if (seccion) {
      enAudio = seccion[1].toLowerCase() === 'audio';
      if (enAudio) seccionVista = true;
      continue;
    }
    if (!enAudio) continue;
    const dispositivo = linea.match(RE_DISPOSITIVO);
    if (dispositivo) {
      dispositivos.push({ id: dispositivo[1], name: dispositivo[2] });
    }
  }
  // sección ausente, o presente sin entradas legibles: no hay listado
  return seccionVista && dispositivos.length > 0 ? dispositivos : null;
}

// Parser puro de `system_profiler SPAudioDataType -json`: de
// SPAudioDataType[0]._items extrae nombre + flags de default del SO.
// El valor del flag es irrelevante (system_profiler usa strings
// `spaudio_yes`): decide su PRESENCIA. Ilegible (JSON roto, raíz
// ajena, sin _items, item sin nombre) → null, jamás throw.
export function parseSystemProfilerJson(json) {
  if (typeof json !== 'string' || json.trim() === '') return null;
  let datos;
  try {
    datos = JSON.parse(json);
  } catch {
    return null;
  }
  const items = Array.isArray(datos?.SPAudioDataType)
    ? datos.SPAudioDataType[0]?._items : undefined;
  if (!Array.isArray(items) || items.length === 0) return null;
  const dispositivos = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
        || typeof item._name !== 'string' || item._name === '') {
      return null; // un item ilegible invalida el listado entero
    }
    dispositivos.push({
      name: item._name,
      default_input: item.coreaudio_default_audio_input_device != null,
      default_output: item.coreaudio_default_audio_output_device != null,
    });
  }
  return dispositivos;
}

// Corre una sonda con tope de tiempo. Resuelve SIEMPRE (nunca throw):
//   {fallo: 'spawn'|'timeout'}  — binario ausente / tope excedido
//   {exit, stdout, stderr}      — el proceso corrió y terminó
// El exit NO decide nada: los consumidores juzgan por contenido.
function correr(argv, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let terminado = false;
    const fin = (r) => {
      if (terminado) return;
      terminado = true;
      resolve(r);
    };
    let hijo;
    try {
      hijo = spawn(argv[0], argv.slice(1), {
        signal: AbortSignal.timeout(timeoutMs),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return fin({ fallo: 'spawn' });
    }
    hijo.stdout.setEncoding('utf8');
    hijo.stderr.setEncoding('utf8');
    hijo.stdout.on('data', (d) => {
      if (stdout.length < TOPE_SALIDA) stdout += d;
    });
    hijo.stderr.on('data', (d) => {
      if (stderr.length < TOPE_SALIDA) stderr += d;
    });
    hijo.on('error', (e) => {
      // ENOENT (binario ausente) o AbortError (tope): fallo de la
      // fuente; la causa contratada la decide el llamador.
      fin({ fallo: e?.name === 'AbortError' ? 'timeout' : 'spawn' });
    });
    hijo.on('close', () => fin({ exit: hijo.exitCode, stdout, stderr }));
  });
}

// Listado de ENTRADAS según ffmpeg — la ÚNICA fuente de la validación
// de la selección por nombre (G2a): sin system_profiler y sin defaults
// del SO, la decisión de captura no se apoya en otra fuente. → array
// de parseListadoFfmpeg o null si el binario no corrió o el listado no
// es legible (fail-closed, jamás throw; sólo lectura, no abre canal).
export async function listarEntradasFfmpeg(
  { timeoutMs = TIMEOUT_MS } = {}
) {
  const ffmpeg = rutaFfmpeg();
  if (!ffmpeg) return null;
  const ff = await correr([ffmpeg, '-hide_banner', '-f', 'avfoundation',
    '-list_devices', 'true', '-i', ''], timeoutMs);
  if (ff.exit === undefined) return null;
  return parseListadoFfmpeg(`${ff.stderr}\n${ff.stdout}`);
}

// Inventario de audio del host local (sólo lectura). {code, data}:
//   exit 0 → {devices, platform, captured_at,
//             limits: {id_estable: false, seleccion_salida: false},
//             degraded?: ['ffmpeg'|'system_profiler']}
//   exit 1 → {error: 'devices_unavailable',
//             causa: 'plataforma_no_soportada'|'ffmpeg_ausente'|
//                    'listado_ilegible'}
// Degradación honesta: si una fuente falla pero la otra lista, se
// entrega lo listado con `degraded` nombrando la fuente caída. Fallo
// total sólo si AMBAS fallan. Sin tocar canal.lock: el inventario no
// abre el canal. `plataforma` inyectable para tests herméticos (mismo
// patrón que argsCaptura en stt.mjs).
export async function listarDispositivos(
  { plataforma = process.platform, timeoutMs = TIMEOUT_MS } = {}
) {
  if (plataforma !== 'darwin') {
    // Una plataforma sin backend no prueba nada sobre los dispositivos:
    // fallo explícito de inventario, sin inferencias.
    return { code: 1, data: { error: 'devices_unavailable',
      causa: 'plataforma_no_soportada' } };
  }
  const ffmpeg = rutaFfmpeg();
  const [ff, sp] = await Promise.all([
    ffmpeg
      ? correr([ffmpeg, '-hide_banner', '-f', 'avfoundation',
          '-list_devices', 'true', '-i', ''], timeoutMs)
      : Promise.resolve({ fallo: 'spawn' }),
    correr([rutaSystemProfiler(), 'SPAudioDataType', '-json'], timeoutMs),
  ]);
  // ffmpeg lista por stderr (avfoundation); el stdout se adjunta por si
  // una build lo escribe allí — el parser busca la sección por contenido.
  const entradas = ff.exit !== undefined
    ? parseListadoFfmpeg(`${ff.stderr}\n${ff.stdout}`) : null;
  const items = sp.exit !== undefined
    ? parseSystemProfilerJson(sp.stdout) : null;

  if (entradas === null && items === null) {
    // Fallo total. Sólo el binario que NO pudo ejecutarse (spawn
    // fallido o ruta vacía) nombra ffmpeg_ausente; un timeout (el
    // binario existe y corrió) o un listado ilegible tras correr son
    // listado_ilegible — jamás se infiere ausencia de dispositivos de
    // un exit genérico o de un proceso colgado (contrato §3).
    return { code: 1, data: { error: 'devices_unavailable',
      causa: ff.fallo === 'spawn' ? 'ffmpeg_ausente' : 'listado_ilegible' } };
  }

  const devices = [];
  const defaultsEntradaSo = items === null
    ? [] : items.filter((d) => d.default_input).map((d) => d.name);
  if (entradas !== null) {
    for (const d of entradas) {
      devices.push({
        kind: 'input',
        id: d.id,
        name: d.name,
        source: 'ffmpeg',
        is_default_glosomata: d.id === '0',
        // match por nombre, best-effort: homónimos quedan todos marcados
        ...(defaultsEntradaSo.includes(d.name) ? { is_default_so: true } : {}),
      });
    }
  }
  if (items !== null) {
    for (const d of items) {
      if (d.default_output) {
        devices.push({ kind: 'output', id: null, name: d.name,
          source: 'system', is_default_so: true });
      }
      if (d.default_input) {
        devices.push({ kind: 'input', id: null, name: d.name,
          source: 'system', is_default_so: true });
      }
    }
  }
  const degraded = [];
  if (entradas === null) degraded.push('ffmpeg');
  if (items === null) degraded.push('system_profiler');
  return { code: 0, data: {
    devices,
    platform: plataforma,
    captured_at: new Date().toISOString(),
    limits: { id_estable: false, seleccion_salida: false },
    ...(degraded.length > 0 ? { degraded } : {}),
  } };
}
