// STT: ffmpeg (avfoundation darwin / alsa linux) → WAV 16 kHz mono →
// whisper-cli. Retorna {code, data}; nunca escribe stdout.

import { cargarMatriz } from './matriz.mjs';
import {
  adquirirCanal, liberarCanal, resetStop, stopGeneration, stopPedido,
  spawnGrupo, matarGrupo, nuevoTemporal,
} from './canal.mjs';
import {
  rm, stat, readFile, writeFile, access, constants,
} from 'node:fs/promises';
import { measureOperation } from './duration.mjs';

const UMBRAL_RMS = 120; // amplitud media mínima (s16le) para considerar voz

// Fin de turno por silencio: `--timeout` es el TOPE, no la duración. Tras
// detectar voz, ~1.5 s de silencio cierra la captura (antes el micrófono
// quedaba abierto el timeout completo). Tramos de 100 ms a 16 kHz s16le.
// 1 s cortaba al humano en las pausas para pensar (medido en vivo,
// 2026-11-13): 1.5 s.
const TRAMO_BYTES = 3200;
const TRAMOS_CALIBRACION = 3; // piso de ruido: primeros 300 ms
const TRAMOS_SILENCIO_FIN = 15; // 1.5 s de silencio tras voz

// Tono de turno: avisa al humano que el micrófono se abre (pedido del
// Operador, 2026-11-13). Suena ANTES de abrir el micrófono, para no
// contaminar la calibración del piso. Best-effort: sin tono o si falla,
// listen sigue; sólo `stopped` se propaga. GLOSOMATA_TONO='' lo apaga
// (tests); otra ruta lo cambia. Fuera de darwin no hay tono por defecto.
export function rutaTono(plataforma = process.platform, env = process.env) {
  if (env.GLOSOMATA_TONO !== undefined) return env.GLOSOMATA_TONO || null;
  return plataforma === 'darwin' ? '/System/Library/Sounds/Tink.aiff' : null;
}

async function sonarTono() {
  const ruta = rutaTono();
  if (!ruta) return;
  try {
    await access(ruta, constants.R_OK);
    await correr('/usr/bin/afplay', [ruta]);
  } catch (e) {
    if (e.code === 'stopped') throw e;
  }
}

// Detector puro (testeable sin micrófono): alimentar(buf) → true cuando
// hubo voz y luego TRAMOS_SILENCIO_FIN tramos bajo el umbral. Fail-safe:
// sin voz detectada jamás corta — decide el timeout, como antes.
// Piso = percentil 10 de TODO lo escuchado, no el máximo de los primeros
// 300 ms: con el tono de turno el humano habla de inmediato y la
// calibración medía su voz (piso 1576 → umbral 4978 con una voz de
// pico 1576; jamás cortaba — medido en vivo, 2026-11-13). «Hubo voz» se
// juzga con el máximo histórico contra el umbral VIGENTE, para no perder
// la voz que llegó antes de que el piso aprendiera el ruido.
const PERCENTIL_PISO = 0.1;
const FACTOR_UMBRAL = 2.5;
const MARGEN_UMBRAL = 150;

export function crearDetectorFin(silencioTramos = TRAMOS_SILENCIO_FIN) {
  let pendiente = Buffer.alloc(0);
  const historia = [];
  let maximo = 0;
  let silencio = 0;
  return {
    alimentar(buf) {
      pendiente = Buffer.concat([pendiente, buf]);
      while (pendiente.length >= TRAMO_BYTES) {
        const r = rmsS16(pendiente.subarray(0, TRAMO_BYTES));
        pendiente = pendiente.subarray(TRAMO_BYTES);
        historia.push(r);
        maximo = Math.max(maximo, r);
        if (historia.length <= TRAMOS_CALIBRACION) continue;
        const orden = [...historia].sort((a, b) => a - b);
        const piso = orden[Math.floor((orden.length - 1) * PERCENTIL_PISO)];
        const umbral = piso * FACTOR_UMBRAL + MARGEN_UMBRAL;
        silencio = r > umbral ? 0 : silencio + 1;
        if (maximo > umbral && silencio >= silencioTramos) return true;
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

// VAD Silero (opcional: engines.stt.vad_bin = whisper.cpp
// `whisper-vad-speech-segments`, engines.stt.vad_model = ggml-silero).
// Detecta VOZ HUMANA, no volumen: música sin canto, un ventilador o ruido
// no cuentan como voz (con el detector RMS impedían el corte; medido
// 2026-11-13). Cada 500 ms se evalúa una VENTANA de los últimos 6 s
// (16 ms por 7 s de audio, ~340 ms con la carga): coste constante aunque
// el turno dure 120 s (revisión r1, MEDIUM). Fail-safe: un fallo del VAD
// lo apaga para esta captura y rige el detector RMS; el VAD jamás corta
// por error.
const INTERVALO_VAD_TRAMOS = 5;
const SILENCIO_VAD_S = 1.5;
const BYTES_POR_S = 32000; // 16 kHz s16le mono
const VENTANA_VAD_BYTES = 6 * BYTES_POR_S;

// Salida de whisper-vad-speech-segments: «Speech segment N: start = X,
// end = Y» en centésimas de segundo (medido: 199.00 = 1.99 s).
export function parsearSegmentosVad(stdout) {
  const segs = [];
  const re = /Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/g;
  for (const m of stdout.matchAll(re)) {
    segs.push({ inicio: Number(m[1]) / 100, fin: Number(m[2]) / 100 });
  }
  return segs;
}

// ¿Terminó el turno? `segs` y `duracionS` son de la VENTANA evaluada;
// `hablo` dice si hubo voz en alguna ventana anterior. Con voz en la
// ventana: el último segmento terminó hace >= silencioS. Sin voz en la
// ventana pero con voz antes: la ventana entera (> silencioS) es silencio.
// Comparación en centésimas enteras: sin error de coma flotante (r1, LOW).
export function finPorVad(segs, duracionS, hablo = false,
  silencioS = SILENCIO_VAD_S) {
  if (segs.length === 0) return hablo && duracionS >= silencioS;
  const cs = (x) => Math.round(x * 100);
  return cs(duracionS) - cs(segs.at(-1).fin) >= cs(silencioS);
}

function wavDesdePcm(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(BYTES_POR_S, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// VAD sólo si AMBAS claves están declaradas y los archivos existen; si
// no, null (rige el detector RMS, conducta previa intacta).
async function vadDeclarado(cfg, ruta) {
  const bin = cfg.engines?.stt?.vad_bin;
  const model = cfg.engines?.stt?.vad_model;
  if (typeof bin !== 'string' || typeof model !== 'string') return null;
  try {
    await access(bin, constants.X_OK);
    await access(model, constants.R_OK);
  } catch {
    return null;
  }
  return { bin, model, ruta };
}

// Un job VAD a la vez. `cerrar()` (r1, HIGH ×2) mata el proceso VAD en
// vuelo y ESPERA al job: así capturar() no resuelve, ni listen borra el
// temporal, mientras un writeFile o un whisper-vad-speech-segments sigan
// vivos. Tras cerrar, ningún job nuevo escribe audio.
function crearDetectorVad(vad, ruta) {
  let ventana = Buffer.alloc(0);
  let bytes = 0;
  let evaluado = 0;
  let pendiente = null;
  let hijo = null;
  let cerrado = false;
  let hablo = false;
  let fin = false;
  let fallo = false;
  const segmentos = (args) => new Promise((resolve) => {
    hijo = spawnGrupo(vad.bin, args);
    let stdout = '';
    hijo.stdout.on('data', (d) => {
      if (stdout.length < 200_000) stdout += d.toString();
    });
    hijo.on('error', () => { hijo = null; resolve(null); });
    hijo.on('close', (code) => {
      hijo = null;
      resolve(code === 0 && !cerrado ? parsearSegmentosVad(stdout) : null);
    });
  });
  const evaluar = async (pcm) => {
    if (cerrado) return null;
    await writeFile(ruta, wavDesdePcm(pcm), { mode: 0o600 });
    if (cerrado) return null;
    // -vspd 100: un «sí» o «no» dura < 250 ms (mínimo por defecto) y
    // desaparecía; sin segmento no había corte (r2, MEDIUM).
    return segmentos(['-vm', vad.model, '-vspd', '100', '-f', ruta]);
  };
  return {
    get fallo() { return fallo; },
    alimentar(buf) {
      ventana = Buffer.concat([ventana, buf]);
      if (ventana.length > VENTANA_VAD_BYTES) {
        ventana = ventana.subarray(ventana.length - VENTANA_VAD_BYTES);
      }
      bytes += buf.length;
      const tramos = Math.floor(bytes / TRAMO_BYTES);
      if (!cerrado && !fallo && !pendiente && !fin
          && tramos - evaluado >= INTERVALO_VAD_TRAMOS) {
        evaluado = tramos;
        const pcm = Buffer.from(ventana);
        pendiente = evaluar(pcm).then((segs) => {
          if (cerrado) return;
          if (segs === null) { fallo = true; return; }
          if (finPorVad(segs, pcm.length / BYTES_POR_S, hablo)) fin = true;
          if (segs.length > 0) hablo = true;
        }).catch(() => { fallo = true; })
          .finally(() => { pendiente = null; });
      }
      return fin;
    },
    async cerrar() {
      cerrado = true;
      if (hijo) matarGrupo(hijo);
      if (pendiente) await pendiente;
    },
  };
}

// Captura con fin por silencio: ffmpeg duplica el audio a stdout (PCM
// crudo) y el detector decide; al cortar se pide `q` por stdin para que
// ffmpeg cierre el WAV limpio (SIGINT si no responde en 2 s). El WAV
// sigue siendo el último argumento y se valida igual que antes. Con VAD
// declarado y sano decide el VAD; si falla, el detector RMS.
async function capturar(cmd, args, vad = null) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(cmd, args);
    const detector = crearDetectorFin();
    const detectorVad = vad ? crearDetectorVad(vad, vad.ruta) : null;
    let fin = false;
    let porVad = false;
    let respaldo = null;
    child.stdout.on('data', (d) => {
      if (fin) return;
      const finRms = detector.alimentar(d);
      const finVad = detectorVad ? detectorVad.alimentar(d) : false;
      const vadSano = detectorVad && !detectorVad.fallo;
      const corta = vadSano ? finVad : finRms;
      if (!corta) return;
      fin = true;
      porVad = !!vadSano;
      child.stdin.write('q');
      respaldo = setTimeout(() => {
        try { process.kill(child.pid, 'SIGINT'); } catch {}
      }, 2000);
    });
    // Toda salida pasa por aquí, UNA vez (r2, LOW): cierra el VAD (mata y
    // espera) antes de resolver o rechazar, para que el temporal no
    // sobreviva al finally. Espera acotada a 250 ms (r2, LOW: stop no debe
    // depender del job): cerrar() ya marcó `cerrado` y mató al hijo de
    // forma síncrona, así que ningún job nuevo escribe audio.
    let salido = false;
    const salir = (fn, v) => {
      if (salido) return;
      salido = true;
      clearInterval(poll);
      clearTimeout(respaldo);
      const espera = detectorVad ? detectorVad.cerrar() : Promise.resolve();
      const tope = new Promise((r) => { setTimeout(r, 250).unref?.(); });
      Promise.race([espera.catch(() => {}), tope]).then(() => fn(v));
    };
    const stopped = () => Object.assign(new Error('stopped'),
      { code: 'stopped' });
    const poll = setInterval(() => {
      if (stopPedido()) {
        matarGrupo(child);
        salir(reject, stopped());
      }
    }, 50);
    child.on('error', () => {
      salir(reject, Object.assign(new Error('spawn'), { code: 'spawn' }));
    });
    child.on('close', (code) => {
      // mismo guard que correr(): stop gana a close (ronda 5, M-1)
      if (stopPedido()) {
        salir(reject, stopped());
        return;
      }
      // corte propio: el código de salida de q/SIGINT no es fallo; el WAV
      // se juzga después (pcmDesdeWav, fail-closed)
      salir(resolve, { code: fin ? 0 : code, porVad });
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
      await sonarTono();
      const vad = await vadDeclarado(cfg, `${t.ruta}.vad.wav`);
      captura = await capturar(ffmpeg, [
        '-y', '-loglevel', 'error',
        ...cap.input,
        '-t', String(timeout),
        '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
        '-t', String(timeout),
        '-ar', '16000', '-ac', '1', '-sample_fmt', 's16',
        t.ruta,
      ], vad);
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
    // Si cortó el VAD, ya oyó voz humana: la puerta RMS fija no lo
    // desmiente con mic_timeout (r2, MEDIUM: voz baja + silencio).
    if (!captura.porVad && rmsS16(pcm) < UMBRAL_RMS) {
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
      await rm(`${t.ruta}.vad.wav`, { force: true }).catch(() => {});
    }
    await liberarCanal();
  }
}
