// Envoltorio HTTP del whisper-server de whisper.cpp (ADR-014, ACEPTADO).
// Expone la forma chat/completions + input_audio que tequio ya habla,
// con credenciales locales (Bearer + X-Project-ID), cerrojo GPU
// compartido sin espera, inferencia serializada y cola acotada.
// Artefacto de despliegue para Malintzin: el NÚCLEO de glosomata no lo
// ejecuta ni lo instala (contrato de consumo §2.6). Node >= 20, ESM,
// CERO dependencias npm (sólo stdlib).
//
// PRIVACIDAD (exigible en revisión): nada de audio ni transcripción en
// disco; el stderr lleva SOLO ids, códigos y duraciones — jamás audio,
// transcripción, token ni echo. Las respuestas de error son JSON con
// código y mensaje estático, sin fragmentos del payload.
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const MODELO_SERVIDO = 'large-v3-turbo-q8_0';
export const MAX_CUERPO_BYTES = 25 * 1024 * 1024; // tope §6: base64 del tramo
export const MAX_DURACION_AUDIO_S = 120; // tope §6: duración del tramo
const BYTES_POR_SEGUNDO = 32000; // PCM 16 kHz mono, s16le
const RETRY_AFTER = '2';
const PROBE_MS = 400;

// Fallo con respuesta HTTP contratada. `retryAfter` viaja como cabecera.
class FalloHttp extends Error {
  constructor(estado, code, mensaje, retryAfter = null) {
    super(code);
    this.estado = estado;
    this.code = code;
    this.mensaje = mensaje;
    this.retryAfter = retryAfter;
  }
}

class FalloArranque extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const demora = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Log de una línea a stderr: códigos, ids y duraciones; nada más.
function logLinea(code, campos = {}) {
  process.stderr.write(
    JSON.stringify({ t: new Date().toISOString(), code, ...campos }) + '\n');
}

// ---------- Config (variables STT_TURBO_*, ver README.md) ----------

export function leerConfig(env = process.env) {
  const entero = (valor, defecto, min, max) => {
    const n = Number(valor);
    if (!Number.isFinite(n) || n < min || n > max) return defecto;
    return Math.trunc(n);
  };
  const texto = (valor, defecto) =>
    (typeof valor === 'string' && valor.length > 0 ? valor : defecto);
  const inferenciaMs = entero(env.STT_TURBO_INFERENCIA_MS,
    180000, 1000, 86400000);
  // El `sleep` del tenedor nunca puede expirar ANTES que la inferencia
  // que protege: piso atado al timeout (regla operativa hecha código).
  const lockSleepS = Math.max(
    entero(env.STT_TURBO_LOCK_SLEEP_S, 300, 1, 86400),
    Math.ceil(inferenciaMs / 1000));
  return {
    host: texto(env.STT_TURBO_BIND, '127.0.0.1'),
    port: entero(env.STT_TURBO_PORT, 8093, 1, 65535),
    projectId: texto(env.STT_TURBO_PROJECT_ID, 'tequio'),
    tokensRuta: texto(env.STT_TURBO_TOKENS, null),
    lang: texto(env.STT_TURBO_LANG, 'es'),
    whisperBin: texto(env.STT_TURBO_WHISPER_BIN, null),
    modeloRuta: texto(env.STT_TURBO_MODEL, null),
    modeloSha256: texto(env.STT_TURBO_MODEL_SHA256, null),
    puertoInterno: entero(env.STT_TURBO_INTERNAL_PORT, 0, 0, 65535),
    queueMax: entero(env.STT_TURBO_QUEUE, 4, 0, 1000),
    lockModo: env.STT_TURBO_LOCK === 'none' ? 'none' : 'auto',
    lockSleepS,
    lockRuta: typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR
      ? path.join(env.XDG_RUNTIME_DIR, 'stt-turbo-gpu.lock') : null,
    inferenciaMs,
  };
}

// ---------- Credenciales: lista de tokens 0600 + recarga por mtime ----------

// Comparación en tiempo constante: timingSafeEqual exige longitudes
// iguales; con longitudes distintas se ejecuta una comparación de
// relleno para conservar el patrón de tiempo y se devuelve false.
function compararConstante(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

// Archivo de tokens (una por línea; la primera es la vigente, el resto
// «en gracia» durante la rotación §7b). Recarga sin reinicio cuando
// cambia mtime+tamaño+inodo+MODO: el modo entra en la clave para que
// un `chmod` tardío (0644→0600 o el inverso) siempre re-evalúe
// (corrección r1, M1). Cualquier problema (ausente, ilegible, perms >
// 0600) deja la lista VACÍA: toda credencial cae en 401 determinista,
// jamás 5xx (§7a). Fail-closed recuperable: el archivo puede aparecer
// después y la siguiente petición lo carga.
export function crearAlmacenTokens(ruta, log) {
  let cache = { tokens: [], mtimeMs: -1, size: -1, ino: -1, modo: -1 };
  let ultimoProblema = null;
  const cargar = () => {
    let st;
    try {
      st = fs.statSync(ruta);
    } catch {
      if (ultimoProblema !== 'tokens_ilegible') {
        log('tokens_ilegible');
        ultimoProblema = 'tokens_ilegible';
      }
      return { tokens: [] };
    }
    const modo = st.mode & 0o777;
    if (cache.mtimeMs === st.mtimeMs && cache.size === st.size
        && cache.ino === st.ino && cache.modo === modo) return cache;
    try {
      if ((st.mode & 0o077) !== 0) throw new Error('perms');
      const tokens = fs.readFileSync(ruta, 'utf8')
        .split('\n').map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
      cache = { tokens, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino,
        modo };
      if (ultimoProblema !== null) log('tokens_cargados', { n: tokens.length });
      ultimoProblema = null;
      return cache;
    } catch {
      log('tokens_invalidos', { modo: modo.toString(8) });
      ultimoProblema = 'tokens_invalidos';
      cache = { tokens: [], mtimeMs: st.mtimeMs, size: st.size, ino: st.ino,
        modo };
      return cache;
    }
  };
  return {
    // Valida Bearer contra TODAS las líneas y el proyecto exacto, ambos
    // en tiempo constante. Sin corto-circuito: todas las líneas se
    // comparan siempre.
    verificar(bearer, proyecto, projectIdEsperado) {
      const { tokens } = cargar();
      let ok = false;
      for (const t of tokens) ok = compararConstante(t, bearer) || ok;
      return ok && compararConstante(projectIdEsperado, proyecto);
    },
  };
}

// ---------- Audio: extracción de la forma chat y validación WAV ----------

// Devuelve el PRIMER input_audio del cuerpo ({data, format}) o null.
// Todo lo demás del formato chat (texto, model, campos extra) se
// ignora: nada del cuerpo influye en la inferencia (§8.2).
export function extraerInputAudio(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object' || !Array.isArray(cuerpo.messages)) {
    return null;
  }
  for (const mensaje of cuerpo.messages) {
    if (!mensaje || typeof mensaje !== 'object'
        || !Array.isArray(mensaje.content)) continue;
    for (const parte of mensaje.content) {
      if (parte && typeof parte === 'object' && parte.type === 'input_audio'
          && parte.input_audio && typeof parte.input_audio.data === 'string') {
        return { data: parte.input_audio.data,
          format: parte.input_audio.format };
      }
    }
  }
  return null;
}

// WAV RIFF PCM 16 kHz mono s16le. Recorre los chunks (fmt/data); los
// chunks `data` se SUMAN: un WAV adversario con varios `data` no puede
// esconder duración en el último (hallazgo M1 de la revisión). Sin
// conversión de códec (§1): cualquier desviación es 415 con código.
export function validarWav(buf) {
  const mal = (code) => ({ ok: false, code });
  if (!Buffer.isBuffer(buf) || buf.length < 44) return mal('formato_audio_invalido');
  if (buf.toString('ascii', 0, 4) !== 'RIFF'
      || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return mal('formato_audio_invalido');
  }
  let offset = 12;
  let fmt = null;
  let dataBytes = 0;
  let vioData = false;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const inicio = offset + 8;
    if (inicio + size > buf.length) return mal('formato_audio_invalido');
    if (id === 'fmt ' && size >= 16) {
      // Un segundo fmt es ambiguo (lectores WAV discrepan sobre cuál
      // manda): fail-closed en vez de adivinar (residual de la ronda
      // adversarial 2).
      if (fmt) return mal('formato_audio_invalido');
      fmt = {
        codec: buf.readUInt16LE(inicio),
        canales: buf.readUInt16LE(inicio + 2),
        tasa: buf.readUInt32LE(inicio + 4),
        bits: buf.readUInt16LE(inicio + 14),
      };
    } else if (id === 'data') {
      dataBytes += size;
      vioData = true;
    }
    offset = inicio + size + (size % 2); // chunks alineados a 2 bytes
  }
  if (!fmt || !vioData) return mal('formato_audio_invalido');
  if (fmt.codec !== 1) return mal('codec_no_soportado');
  if (fmt.bits !== 16) return mal('codec_no_soportado');
  if (fmt.canales !== 1) return mal('canales_no_soportados');
  if (fmt.tasa !== 16000) return mal('tasa_no_soportada');
  const duracionS = dataBytes / BYTES_POR_SEGUNDO;
  if (duracionS > MAX_DURACION_AUDIO_S) return mal('audio_demasiado_largo');
  return { ok: true, duracionS };
}

// ---------- Cerrojo GPU (protocolo de Malintzin, §8.4) ----------

// Adquisición COMPARTIDA y SIN ESPERA por tramo: un proceso
// `flock -s -n <ruta> sleep <tope>` actúa de tenedor del fd; liberar es
// matarlo. Si flock(1) no existe (macOS) o falta XDG_RUNTIME_DIR, la
// capa falla CERRADA (503) salvo STT_TURBO_LOCK=none explícito de
// desarrollo. Inyectable en tests vía deps.cerrojo.
export function crearCerrojoFlock(cfg, log) {
  return {
    async acquire() {
      if (cfg.lockModo === 'none') return { ok: true, release() {} };
      if (!cfg.lockRuta) {
        log('cerrojo_sin_runtime_dir');
        return { ok: false, razon: 'no_disponible' };
      }
      // Grupo propio: flock(1) SIN -F hace fork y el `sleep` hereda el
      // fd del cerrojo (hallazgo H1); liberar exige matar al GRUPO
      // entero, no sólo al padre.
      const tenedor = spawn('flock',
        ['-s', '-n', cfg.lockRuta, 'sleep', String(cfg.lockSleepS)],
        { stdio: 'ignore', detached: true });
      const fin = new Promise((resolve) => {
        tenedor.once('error', () => resolve('error'));
        tenedor.once('exit', () => resolve('exit'));
      });
      // flock -n desiste de inmediato: si el proceso sigue vivo tras la
      // gracia, el cerrojo compartido está retenido. (Residual: un
      // fallo de flock que tarde más de la gracia en aparecer se
      // leería como adquirido — documentado en el README.)
      const visto = await Promise.race([fin, demora(150).then(() => 'vivo')]);
      if (visto === 'vivo') {
        return { ok: true,
          release() {
            try {
              if (tenedor.pid) process.kill(-tenedor.pid, 'SIGKILL');
            } catch { /* el grupo ya murió */ }
            try { tenedor.kill('SIGKILL'); } catch { /* ya murió */ }
          } };
      }
      log(visto === 'error' ? 'cerrojo_flock_ausente' : 'cerrojo_ocupado');
      return { ok: false, razon: visto === 'error' ? 'no_disponible' : 'ocupado' };
    },
  };
}

// ---------- Hijo whisper-server y llamada de inferencia ----------

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function pedir(base, opciones, cuerpo) {
  return new Promise((resolve) => {
    let resuelto = false;
    const terminar = (r) => { if (!resuelto) { resuelto = true; resolve(r); } };
    const req = http.request(base, opciones, (res) => {
      const trozos = [];
      res.on('data', (t) => trozos.push(t));
      res.on('end', () =>
        terminar({ estado: res.statusCode, cuerpo: Buffer.concat(trozos) }));
      // Corte a mitad de cuerpo (RST o FIN del hijo sin 'end'): sin
      // estos oyentes la promesa colgaría para siempre y envenenaría
      // la cola de inferencia (hallazgo B1 de la revisión adversarial).
      res.on('error', () => terminar({ estado: 0, cuerpo: Buffer.alloc(0) }));
      res.on('close', () => {
        if (!res.complete) terminar({ estado: 0, cuerpo: Buffer.alloc(0) });
      });
    });
    // req.destroy() tras timeout NO emite 'error': resolver aquí o la
    // petición colgaría para siempre (fail-closed explícito).
    req.on('timeout', () => {
      req.destroy();
      terminar({ estado: 0, cuerpo: Buffer.alloc(0), timeout: true });
    });
    req.on('error', () => terminar({ estado: 0, cuerpo: Buffer.alloc(0) }));
    if (cuerpo) req.end(cuerpo);
    else req.end();
  });
}

async function sha256Archivo(ruta) {
  return new Promise((resolve, reject) => {
    const flujo = fs.createReadStream(ruta);
    const hash = crypto.createHash('sha256');
    flujo.on('data', (d) => hash.update(d));
    flujo.on('error', reject);
    flujo.on('end', () => resolve(hash.digest('hex')));
  });
}

// multipart/form-data manual (cero deps): file + language (FIJO por
// config; nada del cuerpo lo cambia, §8.2) + response_format.
function construirMultipart(audio, lang) {
  const boundary = '----stt-turbo-' + crypto.randomBytes(8).toString('hex');
  const campo = (nombre, valor) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${nombre}"` +
    `\r\n\r\n${valor}\r\n`);
  const cuerpo = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; ` +
      `name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    audio,
    Buffer.from('\r\n'),
    campo('language', lang),
    campo('response_format', 'json'),
    campo('temperature', '0'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  return { cuerpo, headers: {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': cuerpo.length } };
}

// ---------- Servidor ----------

export function crearServidor(env, deps = {}) {
  const cfg = leerConfig(env);
  const log = deps.log ?? logLinea;
  const tokens = crearAlmacenTokens(cfg.tokensRuta, log);
  const cerrojo = deps.cerrojo ?? crearCerrojoFlock(cfg, log);
  let hijo = null;
  let upstreamBase = null; // http://127.0.0.1:<puerto interno>
  let cierreDeliberado = false; // apagado propio: la muerte del hijo no cuenta

  // Concurrencia 1: cola de promesas serializa la inferencia; enCurso
  // cuenta la que corre + las que esperan; el tope de ESPERA es
  // queueMax (1 + queueMax en vuelo). Desborde -> 503 cola_llena.
  let enCurso = 0;
  let cola = Promise.resolve();

  const responderError = (res, fallo) => {
    const headers = { 'content-type': 'application/json' };
    if (fallo.retryAfter) headers['retry-after'] = fallo.retryAfter;
    res.writeHead(fallo.estado, headers);
    res.end(JSON.stringify({ error: { code: fallo.code,
      message: fallo.mensaje } }));
  };

  const salud = async () => {
    if (!upstreamBase) return false;
    const r = await pedir(upstreamBase, { method: 'GET', timeout: PROBE_MS });
    return r.estado > 0;
  };

  const inferir = async (audio) => {
    // Hijo muerto: la base se retira en el handler de exit para no
    // hablar con quien re-bindtee el puerto efímero (hallazgo L3).
    if (!upstreamBase) throw new FalloHttp(503, 'hijo_no_disponible',
      'proceso hijo no disponible');
    const { cuerpo, headers } = construirMultipart(audio, cfg.lang);
    const r = await pedir(`${upstreamBase}/inference`,
      { method: 'POST', timeout: cfg.inferenciaMs, headers }, cuerpo);
    if (r.timeout) throw new FalloHttp(502, 'inferencia_fallida',
      'el motor no respondió en el tope');
    if (r.estado === 0) throw new FalloHttp(503, 'hijo_no_disponible',
      'proceso hijo no disponible');
    if (r.estado !== 200) throw new FalloHttp(502, 'inferencia_fallida',
      'el motor de transcripción falló');
    try {
      const parsed = JSON.parse(r.cuerpo.toString('utf8'));
      if (typeof parsed.text !== 'string') throw new Error('forma');
      return parsed.text;
    } catch {
      throw new FalloHttp(502, 'inferencia_fallida',
        'respuesta del motor ilegible');
    }
  };

  const procesarTramo = async (audio, estaMuerto) => {
    // Cliente que ya se fue: NO adquiere el cerrojo ni consume
    // inferencia (corrección r1, M2). Segunda comprobación tras la
    // (posible) espera del cerrojo, por si abortó mientras esperaba.
    if (estaMuerto && estaMuerto()) return { descartada: true };
    const lock = await cerrojo.acquire();
    if (!lock.ok) {
      if (lock.razon === 'no_disponible') {
        throw new FalloHttp(503, 'cerrojo_no_disponible',
          'cerrojo GPU no disponible en este host');
      }
      throw new FalloHttp(503, 'cerrojo_ocupado',
        'GPU ocupada por diarización', RETRY_AFTER);
    }
    if (estaMuerto && estaMuerto()) {
      lock.release();
      return { descartada: true };
    }
    try {
      return await inferir(audio);
    } finally {
      lock.release();
    }
  };

  const leerCuerpo = (req) => new Promise((resolve, reject) => {
    const declarado = Number(req.headers['content-length'] ?? 0);
    if (declarado > MAX_CUERPO_BYTES) {
      reject(new FalloHttp(413, 'cuerpo_demasiado_grande',
        `cuerpo por encima del tope (${MAX_CUERPO_BYTES} bytes)`));
      req.resume();
      return;
    }
    const trozos = [];
    let total = 0;
    let rechazado = false;
    req.on('data', (t) => {
      if (rechazado) return;
      total += t.length;
      if (total > MAX_CUERPO_BYTES) {
        rechazado = true;
        trozos.length = 0;
        reject(new FalloHttp(413, 'cuerpo_demasiado_grande',
          `cuerpo por encima del tope (${MAX_CUERPO_BYTES} bytes)`));
        req.removeAllListeners('data');
        req.resume();
        return;
      }
      trozos.push(t);
    });
    req.on('end', () => { if (!rechazado) resolve(Buffer.concat(trozos)); });
    req.on('error', () => { if (!rechazado) reject(new FalloHttp(400,
      'request_invalido', 'lectura del cuerpo falló')); });
  });

  const autenticar = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const proyecto = req.headers['x-project-id'];
    // Toda falla de credencial es 401 determinista (§7a): nunca 5xx.
    if (!m || typeof proyecto !== 'string'
        || !tokens.verificar(m[1], proyecto, cfg.projectId)) {
      throw new FalloHttp(401, 'unauthorized', null);
    }
  };

  const manejarCompletions = async (req, res) => {
    autenticar(req);
    const bruto = await leerCuerpo(req);
    let cuerpo;
    try {
      cuerpo = JSON.parse(bruto.toString('utf8'));
    } catch {
      throw new FalloHttp(400, 'request_invalido', 'cuerpo JSON ilegible');
    }
    if (cuerpo && (cuerpo.stream === true || cuerpo.stream === 'true')) {
      throw new FalloHttp(400, 'streaming_no_soportado',
        'streaming no soportado en v1');
    }
    const audioParte = extraerInputAudio(cuerpo);
    if (!audioParte) {
      throw new FalloHttp(400, 'audio_ausente',
        'no se encontró input_audio en messages');
    }
    if (audioParte.format !== undefined && audioParte.format !== 'wav') {
      throw new FalloHttp(415, 'codec_no_soportado',
        'sólo WAV; sin conversión de códec');
    }
    const audio = Buffer.from(audioParte.data, 'base64');
    const valida = validarWav(audio);
    if (!valida.ok) {
      const estado = valida.code === 'audio_demasiado_largo' ? 413 : 415;
      const mensaje = valida.code === 'audio_demasiado_largo'
        ? `tramo por encima del tope (${MAX_DURACION_AUDIO_S} s)`
        : 'audio no es WAV PCM 16 kHz mono';
      throw new FalloHttp(estado, valida.code, mensaje);
    }
    if (enCurso >= 1 + cfg.queueMax) {
      throw new FalloHttp(503, 'cola_llena', 'cola de inferencia llena',
        RETRY_AFTER);
    }
    enCurso++;
    try {
      // Aborto del cliente: res 'close' con la respuesta SIN terminar.
      // (req 'close' NO sirve: en Node >= 16 también dispara al
      // completarse el stream del request en conexiones sanas —
      // verificado empíricamente; con req se descartaría a todos.)
      let abortado = false;
      res.on('close', () => { if (!res.writableEnded) abortado = true; });
      const tarea = cola.then(() => procesarTramo(audio, () => abortado));
      cola = tarea.then(() => {}, () => {});
      const texto = await tarea;
      if (texto !== null && typeof texto === 'object' && texto.descartada) {
        // El cliente ya no está: nada que responder; sólo constancia.
        return { estado: 0, code: 'cliente_abortado' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-' + crypto.randomBytes(12).toString('hex'),
        object: 'chat.completion',
        choices: [{ index: 0,
          message: { role: 'assistant', content: texto },
          finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: MODELO_SERVIDO,
      }));
      return { estado: 200, audioMs: Math.round(valida.duracionS * 1000) };
    } finally {
      enCurso--;
    }
  };

  const server = http.createServer((req, res) => {
    const id = crypto.randomBytes(6).toString('hex');
    const iniciado = performance.now();
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      url = { pathname: req.url };
    }
    Promise.resolve().then(async () => {
      if (url.pathname === '/healthz') {
        if (req.method !== 'GET') {
          throw new FalloHttp(405, 'metodo_no_permitido',
            'healthz sólo acepta GET');
        }
        // Sin auth y sin contenido en el cuerpo: sólo el estado.
        const listo = await salud();
        res.writeHead(listo ? 200 : 503);
        res.end();
        return { estado: listo ? 200 : 503 };
      }
      if (url.pathname === '/v1/chat/completions') {
        if (req.method !== 'POST') {
          throw new FalloHttp(405, 'metodo_no_permitido',
            'completions sólo acepta POST');
        }
        return await manejarCompletions(req, res);
      }
      throw new FalloHttp(404, 'ruta_desconocida', 'ruta no expuesta');
    }).then((info) => {
      log('request', { id, estado: info?.estado ?? 0,
        ...(info?.code ? { code: info.code } : {}),
        ms: Math.round(performance.now() - iniciado),
        ...(info?.audioMs !== undefined ? { audio_ms: info.audioMs } : {}) });
    }, (e) => {
      if (e instanceof FalloHttp) {
        if (e.mensaje === null) {
          // 401 exacto contratado (§7a): sin mensaje, sin detalle.
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":{"code":"unauthorized"}}');
        } else {
          responderError(res, e);
        }
        log('request', { id, estado: e.estado, code: e.code,
          ms: Math.round(performance.now() - iniciado) });
      } else {
        // Fallo no clasificado: estado de fallo explícito, sin contenido.
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'internal_error',
            message: 'fallo interno' } }));
        } else {
          res.end();
        }
        log('request', { id, estado: 500, code: 'internal_error',
          ms: Math.round(performance.now() - iniciado) });
      }
    });
  });

  // Lanza el hijo real (o adopta el inyectado por tests). El arranque
  // fail-closed: config incompleta, bind prohibido o sha distinto
  // abortan el proceso ANTES de abrir el puerto público.
  const iniciar = async () => {
    if (deps.upstreamBase) {
      upstreamBase = deps.upstreamBase;
      return;
    }
    if (cfg.host === '0.0.0.0' || cfg.host === '::') {
      throw new FalloArranque('bind_prohibido');
    }
    if (!cfg.whisperBin || !cfg.modeloRuta) {
      throw new FalloArranque('config_incompleta');
    }
    if (cfg.modeloSha256) {
      let sha = null;
      try {
        sha = await sha256Archivo(cfg.modeloRuta);
      } catch {
        throw new FalloArranque('modelo_ausente');
      }
      if (sha !== cfg.modeloSha256.toLowerCase()) {
        throw new FalloArranque('modelo_sha_mismatch');
      }
      log('modelo_verificado');
    } else {
      log('modelo_sha_no_configurado');
    }
    const puerto = cfg.puertoInterno || (await puertoLibre());
    upstreamBase = `http://127.0.0.1:${puerto}`;
    hijo = spawn(cfg.whisperBin,
      ['--host', '127.0.0.1', '--port', String(puerto),
        '--model', cfg.modeloRuta],
      { stdio: 'ignore' });
    // La salida del hijo NO se reenvía (puede llevar transcripción).
    hijo.once('error', () => log('hijo_spawn_error'));
    hijo.once('exit', (code, signal) => {
      log('hijo_exit', { ...(code !== null ? { code } : { signal }) });
      hijo = null;
      // Retira la base: ni healthz ni inferencia pueden confundir un
      // re-bind del puerto efímero con el hijo (hallazgo L3).
      upstreamBase = null;
      // Corrección r1 (H1): la muerte del hijo TUMBA el envoltorio
      // (exit != 0) para que systemd (Restart=on-failure) recupere la
      // unidad; sin esto el 503 era permanente. Un cierre DELIBERADO
      // (señal de apagado) no cuenta.
      if (!cierreDeliberado && typeof deps.alMorirHijo === 'function') {
        deps.alMorirHijo();
      }
    });
    log('hijo_lanzado', { puerto });
    // Espera activa de escucha (healthz refleja el estado mientras
    // tanto); sin reinicio automático en v1: systemd reinicia la unidad.
    const tope = Date.now() + 120000;
    (async () => {
      while (Date.now() < tope) {
        if (!hijo) return;
        if (await salud()) return log('hijo_listo', { puerto });
        await demora(100);
      }
      log('hijo_no_escucha', { puerto });
    })();
  };

  const cerrar = () => {
    cierreDeliberado = true;
    if (hijo) { hijo.kill('SIGKILL'); hijo = null; }
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(() => resolve()));
  };

  return { server, cfg, iniciar, cerrar, log };
}

// ---------- Entrada (node services/stt-turbo/servidor.mjs) ----------

async function arrancar() {
  const srv = crearServidor(process.env, {
    // H1 (corrección r1): hijo muerto -> el envoltorio baja con
    // exit != 0 y systemd reinicia la unidad. Drenaje breve de lo en
    // vuelo (fallan rápido con 503), sin esperas largas.
    alMorirHijo: () => {
      srv.log('envoltorio_baja', { causa: 'hijo_exit' });
      srv.server.close(() => process.exit(1));
      setTimeout(() => process.exit(1), 2000).unref();
    },
  });
  try {
    await srv.iniciar();
  } catch (e) {
    srv.log('arranque_fallido', { causa: e?.code ?? 'desconocida' });
    process.exit(1);
  }
  srv.server.listen(srv.cfg.port, srv.cfg.host, () => {
    srv.log('arranque', { puerto: srv.cfg.port });
  });
  srv.server.on('error', () => {
    srv.log('escucha_fallida', { puerto: srv.cfg.port });
    process.exit(1);
  });
  const apagar = () => {
    srv.cerrar().finally(() => process.exit(0));
  };
  process.on('SIGTERM', apagar);
  process.on('SIGINT', apagar);
}

if (process.argv[1] && process.argv[1].endsWith('servidor.mjs')) {
  arrancar();
}
