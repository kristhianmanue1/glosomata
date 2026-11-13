// STT: ffmpeg (avfoundation darwin / alsa linux) → WAV 16 kHz mono →
// whisper-cli. Retorna {code, data}; nunca escribe stdout.

import { cargarMatriz } from './matriz.mjs';
import {
  adquirirCanal, liberarCanal, resetStop, stopGeneration, stopPedido,
  spawnGrupo, matarGrupo, nuevoTemporal,
} from './canal.mjs';
import { rm, stat, readFile, access, constants } from 'node:fs/promises';
import { measureOperation } from './duration.mjs';

const UMBRAL_RMS = 120; // amplitud media mínima (s16le) para considerar voz

// Fin de turno por silencio: `--timeout` es el TOPE, no la duración. Tras
// detectar voz, ~1 s de silencio cierra la captura (antes el micrófono
// quedaba abierto el timeout completo). Tramos de 100 ms a 16 kHz s16le.
const TRAMO_BYTES = 3200;
const TRAMOS_CALIBRACION = 3; // piso de ruido: primeros 300 ms
const TRAMOS_SILENCIO_FIN = 10; // 1 s de silencio tras voz

// Detector puro (testeable sin micrófono): alimentar(buf) → true cuando
// hubo voz y luego TRAMOS_SILENCIO_FIN tramos bajo el umbral. Fail-safe:
// sin voz detectada jamás corta — decide el timeout, como antes.
export function crearDetectorFin(silencioTramos = TRAMOS_SILENCIO_FIN) {
  let pendiente = Buffer.alloc(0);
  let n = 0;
  let piso = 0;
  let habla = false;
  let silencio = 0;
  return {
    alimentar(buf) {
      pendiente = Buffer.concat([pendiente, buf]);
      while (pendiente.length >= TRAMO_BYTES) {
        const r = rmsS16(pendiente.subarray(0, TRAMO_BYTES));
        pendiente = pendiente.subarray(TRAMO_BYTES);
        if (n++ < TRAMOS_CALIBRACION) {
          piso = Math.max(piso, r);
        } else if (r > piso * 3 + 250) {
          habla = true;
          silencio = 0;
        } else if (habla && ++silencio >= silencioTramos) {
          return true;
        }
      }
      return false;
    },
  };
}

// Captura por plataforma (LOW ronda 3): backend de entrada de ffmpeg.
// darwin→avfoundation: sin nombre → :0 (conducta original intacta);
// con nombre exacto → binding por NOMBRE (G2a): `:<nombre>` — el nombre
// lo resuelve AVFoundation AL ABRIR, dentro del mismo proceso ffmpeg;
// el id numérico del listado JAMÁS viaja a ffmpeg. linux→alsa default;
// la selección por nombre no existe ahí: con nombre, fail-closed (null)
// y listen responde not_supported. El resto: fail-closed.
// Función pura para testear sin micrófono ni binario.
export function argsCaptura(plataforma, nombre) {
  if (plataforma === 'darwin') {
    return { bin: '/opt/homebrew/bin/ffmpeg',
      input: ['-f', 'avfoundation', '-i',
        typeof nombre === 'string' ? `:${nombre}` : ':0'] };
  }
  if (plataforma === 'linux') {
    if (typeof nombre === 'string') return null;
    return { bin: '/usr/bin/ffmpeg',
      input: ['-f', 'alsa', '-i', 'default'] };
  }
  return null;
}

// Forma del nombre exacto (G2a, fail-closed ANTES de abrir): vacío, con
// ':' o comillas (rompen la sintaxis `-i "[V]:[A]"`) o EXACTAMENTE un
// alias reservado del backend avfoundation según sus docs oficiales
// ('default'/'none' — indistinguible de un alias) se rechaza. La MISMA
// regla gobierna listen (--device y preferencia) y config validate
// (TIPO y FORMA de engines.stt.input_device; la PRESENCIA se juzga al
// abrir contra el listado fresco, nunca aquí). Válida → null.
const ALIAS_RESERVADOS = new Set(['default', 'none']);

export function causaFormaNombre(nombre) {
  if (typeof nombre !== 'string' || nombre.length === 0) return 'vacio';
  if (/[:'"]/.test(nombre)) return 'charset';
  if (ALIAS_RESERVADOS.has(nombre)) return 'alias';
  return null;
}

// Diagnóstico compartido (doctor C0.2): UNA definición de resolución y
// checks para listen/engines/doctor — sin copias que deriven.
export function rutaFfmpeg() {
  return process.env.GLOSOMATA_FFMPEG
    ?? argsCaptura(process.platform)?.bin ?? null;
}

export async function diagnosticoCaptura() {
  const ruta = rutaFfmpeg();
  if (!ruta) return { ok: false, causa: 'plataforma_no_soportada' };
  try {
    await access(ruta, constants.F_OK);
    return { ok: true };
  } catch {
    return { ok: false, causa: 'ffmpeg_ausente' };
  }
}

export async function diagnosticoWhisper(cfg) {
  try {
    await access(cfg.engines.stt.whisper_bin, constants.F_OK);
  } catch {
    return { ok: false, causa: 'whisper_bin_ausente' };
  }
  try {
    await access(cfg.engines.stt.whisper_model, constants.F_OK);
  } catch {
    return { ok: false, causa: 'whisper_model_ausente' };
  }
  return { ok: true };
}

async function correr(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(cmd, args);
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => {
      if (stdout.length < 200_000) stdout += d.toString();
    });
    const poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        matarGrupo(child);
        reject(Object.assign(new Error('stopped'), { code: 'stopped' }));
      }
    }, 50);
    child.on('error', () => {
      clearInterval(poll);
      reject(Object.assign(new Error('spawn'), { code: 'spawn' }));
    });
    child.on('close', (code) => {
      clearInterval(poll);
      // SIGKILL de stop y close compiten: sin este guard, close ganaba
      // ~5% de las veces y reportaba mic_denied en vez de stopped
      // (ronda 5, M-1 — el fix equivalente de ronda 3 sólo cubrió TTS)
      if (stopPedido()) {
        reject(Object.assign(new Error('stopped'), { code: 'stopped' }));
        return;
      }
      resolve({ code, stdout });
    });
  });
}

// Captura con fin por silencio: ffmpeg duplica el audio a stdout (PCM
// crudo) y el detector decide; al cortar se pide `q` por stdin para que
// ffmpeg cierre el WAV limpio (SIGINT si no responde en 2 s). El WAV
// sigue siendo el último argumento y se valida igual que antes.
async function capturar(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(cmd, args);
    const detector = crearDetectorFin();
    let fin = false;
    let respaldo = null;
    child.stdout.on('data', (d) => {
      if (fin || !detector.alimentar(d)) return;
      fin = true;
      child.stdin.write('q');
      respaldo = setTimeout(() => {
        try { process.kill(child.pid, 'SIGINT'); } catch {}
      }, 2000);
    });
    const poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        clearTimeout(respaldo);
        matarGrupo(child);
        reject(Object.assign(new Error('stopped'), { code: 'stopped' }));
      }
    }, 50);
    child.on('error', () => {
      clearInterval(poll);
      clearTimeout(respaldo);
      reject(Object.assign(new Error('spawn'), { code: 'spawn' }));
    });
    child.on('close', (code) => {
      clearInterval(poll);
      clearTimeout(respaldo);
      // mismo guard que correr(): stop gana a close (ronda 5, M-1)
      if (stopPedido()) {
        reject(Object.assign(new Error('stopped'), { code: 'stopped' }));
        return;
      }
      // corte propio: el código de salida de q/SIGINT no es fallo; el WAV
      // se juzga después (pcmDesdeWav, fail-closed)
      resolve({ code: fin ? 0 : code });
    });
  });
}

// PCM desde WAV caminando chunks RIFF. El header de ffmpeg NO es de 44
// bytes fijos: escribe LIST INFOISFT y 'data' queda en offset 70 —
// asumir 44 contaminaba el RMS con texto del header (176 vs 0 real en
// silencio: mic_timeout jamás disparaba — ronda 5, H-1). Fail-closed:
// WAV ilegible → null (quien llama lo trata como silencio).
export function pcmDesdeWav(buf) {
  if (buf.length < 12
      || buf.toString('latin1', 0, 4) !== 'RIFF'
      || buf.toString('latin1', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let validFormat = false;
  for (let i = 0; i < 64 && pos + 8 <= buf.length; i++) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (pos + 8 + size > buf.length) return null;
    if (id === 'fmt ') {
      if (size < 16) return null;
      const p = pos + 8;
      validFormat = buf.readUInt16LE(p) === 1 // PCM lineal
        && buf.readUInt16LE(p + 2) === 1 // mono
        && buf.readUInt32LE(p + 4) === 16000
        && buf.readUInt16LE(p + 12) === 2 // bytes por muestra
        && buf.readUInt16LE(p + 14) === 16;
    }
    if (id === 'data') {
      return validFormat && size % 2 === 0
        ? buf.subarray(pos + 8, pos + 8 + size) : null;
    }
    pos += 8 + size + (size % 2); // chunks alineados a byte par
  }
  return null;
}

function rmsS16(buf) {
  let suma = 0;
  const n = buf.length / 2;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    suma += v * v;
  }
  return n ? Math.sqrt(suma / n) : 0;
}

export async function listen(argv, stopAtStart = stopGeneration(), opts = {}) {
  return measureOperation(() => listenRaw(argv, stopAtStart, opts));
}

async function listenRaw(argv, stopAtStart, opts = {}) {
  // Inyectables para tests herméticos (mismo patrón que listarDispositivos):
  // `plataforma` (not_supported fuera de darwin es testeable sin CI) y
  // `detalleNombres` (MCP sin detalle de nombres — privacidad).
  const plataforma = opts.plataforma ?? process.platform;
  const detalleNombres = opts.detalleNombres !== false;
  const cfg = await cargarMatriz();
  let timeout = cfg.constraints?.listen_default_timeout_s ?? 10;
  const i = argv.indexOf('--timeout');
  if (i >= 0) {
    const v = Number(argv[i + 1]);
    if (!Number.isFinite(v) || v <= 0 || v > 120) {
      return { code: 2, data: { error: 'usage' } };
    }
    timeout = v;
  }
  // G2a: petición EXPLÍCITA por nombre exacto (`--device`). G2a2: la
  // preferencia de la matriz EFECTIVA es petición implícita. Precedencia:
  // --device > input_device > :0. Una petición se REVALIDA en cada
  // apertura contra el listado fresco y JAMÁS cae a :0 en silencio.
  const iDev = argv.indexOf('--device');
  const pedidoCli = iDev >= 0 ? argv[iDev + 1] : undefined;
  const preferencia = typeof cfg.engines?.stt?.input_device === 'string'
    ? cfg.engines.stt.input_device : undefined;
  const pedido = pedidoCli !== undefined ? pedidoCli : preferencia;
  if (pedido !== undefined && causaFormaNombre(pedido) !== null) {
    return { code: 2, data: { error: 'usage' } };
  }
  const cap = argsCaptura(plataforma, pedido);
  if (!cap) {
    if (pedido !== undefined) {
      // Una plataforma sin backend no sirve la selección por nombre:
      // la petición (explícita o implícita) no es servible ahí.
      return { code: 1, data: { error: 'not_supported' } };
    }
    // Una plataforma sin backend no prueba que falte un dispositivo.
    return { code: 1, data: { error: 'audio_device_error' } };
  }
  // rutaFfmpeg() ya resuelve el bin de esta plataforma (cap no es null aquí)
  const ffmpeg = rutaFfmpeg();
  try {
    await access(ffmpeg);
  } catch {
    return { code: 1, data: { error: 'audio_device_error',
      causa: 'ffmpeg_missing' } };
  }
  // Validación 0/1/N contra el listado fresco (SÓLO la fuente ffmpeg),
  // ANTES de abrir e INNEGOCIABLE: jamás se captura por nombre sin
  // chequeo de homónimos. Fuera de este bloque la captura no se invoca.
  if (pedido !== undefined) {
    const { listarEntradasFfmpeg } = await import('./devices.mjs');
    const listado = await listarEntradasFfmpeg();
    if (listado === null) {
      // No pude verificar el inventario para validar la selección:
      // ni afirma ausencia (device_missing) ni fallo de captura
      // (capture_failed). Fail-closed sin abrir el micrófono.
      return { code: 1, data: { error: 'audio_device_error',
        causa: 'device_list_unavailable' } };
    }
    const nombres = listado.map((d) => d.name);
    const coincidencias = nombres.filter((x) => x === pedido).length;
    if (coincidencias === 0) {
      return { code: 1, data: { error: 'audio_device_error',
        causa: 'device_missing',
        ...(detalleNombres ? { detalle: { disponibles: nombres } } : {}) } };
    }
    if (coincidencias > 1) {
      // Homónimos observados: fail-closed, sin adivinar. El detalle NO
      // incluye nombres (viaja también por MCP).
      return { code: 1, data: { error: 'audio_device_error',
        causa: 'device_missing',
        detalle: `nombre ambiguo: ${coincidencias} coincidencias` } };
    }
  }
  try {
    await adquirirCanal();
  } catch (e) {
    return { code: 1, data: { error: e.code ?? 'internal_error',
      ...(e.code === 'channel_busy' && e.busy_pid
        ? { busy_pid: e.busy_pid } : {}) } };
  }
  resetStop(stopAtStart);
  let t = null;
  let handleClosed = false;
  try {
    // La preparación del WAV también queda protegida por la liberación
    // del lock: un runtime/tmp inválido no debe bloquear el canal.
    t = await nuevoTemporal('stt');
    await t.handle.close();
    handleClosed = true;
    let captura;
    try {
      captura = await capturar(ffmpeg, [
        '-y', '-loglevel', 'error',
        ...cap.input,
        '-t', String(timeout),
        '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
        '-t', String(timeout),
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        t.ruta,
      ]);
    } catch (e) {
      if (e.code === 'stopped') return { code: 1, data: { error: 'stopped' } };
      return { code: 1, data: { error: 'audio_device_error',
        causa: 'capture_failed' } };
    }
    if (captura.code !== 0) {
      return { code: 1, data: { error: 'audio_device_error',
        causa: 'capture_failed' } };
    }
    // silencio: RMS del PCM real por debajo del umbral
    let wav;
    try {
      wav = await readFile(t.ruta);
    } catch {
      return { code: 1, data: { error: 'audio_device_error',
        causa: 'capture_failed' } };
    }
    const pcm = pcmDesdeWav(wav);
    if (!pcm || pcm.length < 3200) {
      return { code: 1, data: { error: 'audio_device_error',
        causa: 'capture_failed' } };
    }
    if (rmsS16(pcm) < UMBRAL_RMS) {
      return { code: 1, data: { error: 'mic_timeout' } };
    }
    let trans;
    try {
      trans = await correr(cfg.engines.stt.whisper_bin, [
        '-m', cfg.engines.stt.whisper_model,
        '-f', t.ruta, '-l', 'es', '-nt', '-np',
      ]);
    } catch (e) {
      if (e.code === 'stopped') return { code: 1, data: { error: 'stopped' } };
      return { code: 1, data: { error: 'stt_failed',
        causa: 'whisper_failed' } };
    }
    if (trans.code !== 0) return { code: 1, data: { error: 'stt_failed',
      causa: 'whisper_failed' } };
    const transcript = trans.stdout
      .split('\n').map((l) => l.trim())
      .filter((l) => l && !/^(whisper_|main:|system_info|read_audio_data)/.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { code: 0, data: { transcript } };
  } finally {
    if (t) {
      if (!handleClosed) await t.handle.close().catch(() => {});
      await rm(t.ruta, { force: true }).catch(() => {});
    }
    await liberarCanal();
  }
}
