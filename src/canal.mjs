// Canal half-duplex v1 — lockfile atómico (O_EXCL), temporales 0700,
// kill-switch por señal cross-process. Contrato: docs/specs/.

import { open, mkdir, rm, readdir, rename, stat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import net from 'node:net';

// GLOSOMATA_RUNTIME aísla el dir de lock/temporales (tests paralelos de la
// suite comparten $TMPDIR con otros procesos de la misma corrida).
const RUNTIME = process.env.GLOSOMATA_RUNTIME
  ? join(process.env.GLOSOMATA_RUNTIME, `glosomata-${process.getuid?.() ?? 'u'}`)
  : join(tmpdir(), `glosomata-${process.getuid?.() ?? 'u'}`);
const LOCK = join(RUNTIME, 'canal.lock');
// Esperadores de stdin (speak --text-stdin): stop cross-process (r3 B1;
// r4 H-5: socket propio por esperador, sin señales a pids de terceros)
const ESPERA = join(RUNTIME, 'espera');
const ORDEN_STOP = 's'; // orden de stop: 1 byte por el socket
const ACUSE_RECEPCION = 'a'; // acuse del esperador: 1 byte de vuelta

// P1.2: backups de config junto al lock — mismo layout per-user
export function rutaBackups() {
  return join(RUNTIME, 'backups');
}

let lockRuta = null;

// Exclusión atómica: create-or-fail. EEXIST → liveness por señal 0;
// sólo se roba si el holder está muerto. (Fix BLOCKER ronda 3: TOCTOU.)
export async function adquirirCanal() {
  await mkdir(RUNTIME, { recursive: true, mode: 0o700 });
  for (let intento = 0; intento < 2; intento++) {
    try {
      const h = await open(LOCK, 'wx');
      await h.write(`${process.pid}`);
      await h.close();
      lockRuta = LOCK;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = 0;
      try {
        pid = Number((await readFile(LOCK, 'utf8')).trim());
      } catch {}
      let vivo = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          vivo = true;
        } catch {}
      }
      if (!vivo) {
        // robo atómico: rename gana un solo ladrón. unlink ciego borraba
        // el lock de un C vivo que robó legítimamente entre nuestro
        // readFile y el unlink (ronda 5, M-2: 3 procesos → dos holders).
        const robo = join(RUNTIME,
          `robo-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
        try {
          await rename(LOCK, robo);
          await unlink(robo).catch(() => {});
        } catch {
          // ENOENT: otro lo robó primero — el wx del loop decide
        }
        continue; // reintenta una vez
      }
      const err = new Error('channel_busy');
      err.code = 'channel_busy';
      // Snapshot diagnóstico: el pid no predice duración ni da autoridad
      // para interrumpir la operación de otro consumidor.
      err.busy_pid = pid;
      throw err;
    }
  }
  const err = new Error('channel_busy');
  err.code = 'channel_busy';
  throw err;
}

export async function liberarCanal() {
  const ruta = lockRuta;
  lockRuta = null;
  if (ruta) await unlink(ruta).catch(() => {});
}

// Registro de esperadores de stdin (speak --text-stdin): `stop` desde
// otro proceso debe alcanzar al lector DURANTE la lectura, cuando aún
// no existe canal.lock (r3, B1). Cada esperador abre un socket local
// propio bajo espera/ y la orden se ENTREGA por ese socket con acuse
// del receptor (r4, H-5): jamás una señal a un pid — un pid reciclado
// no puede recibir el SIGINT de un stop, y conectar al socket de un
// proceso muerto falla (ECONNREFUSED/ENOENT), así que el registro
// huérfano se barre sin receptor. El lock sigue significando exclusión
// de reproducción, no presencia del proceso. Limpieza: finally del
// propio lector; carreras ENOENT (un stop barrió justo antes) son
// normales. La ruta debe caber en sun_path (~104 bytes en darwin): con
// un TMPDIR inusualmente largo el listen falla y la operación falla
// explícito (fail-closed, mismo criterio que un registro fs roto).
export function registrarEspera(alOrden) {
  return new Promise((resolve, reject) => {
    mkdir(ESPERA, { recursive: true, mode: 0o700 }).then(() => {
      const ruta = join(ESPERA,
        `${Math.random().toString(36).slice(2, 8)}.sock`);
      const server = net.createServer();
      server.on('error', reject); // listen fallido → la operación falla
      server.on('connection', (conn) => {
        conn.on('data', () => {
          alOrden();
          conn.end(ACUSE_RECEPCION);
        });
        conn.on('error', () => {});
      });
      server.listen(ruta, () => {
        // tras el bind, un error del server no tumba al esperador: sólo
        // degrada el stop remoto (el local y el SIGINT directo siguen)
        server.removeAllListeners('error');
        server.on('error', () => { try { server.close(); } catch {} });
        resolve({ ruta, server });
      });
    }, reject);
  });
}

export async function liberarEspera(registro) {
  if (!registro) return;
  await new Promise((res) => {
    registro.server.close(() => res());
    registro.server.closeAllConnections?.();
  });
  await unlink(registro.ruta).catch(() => {}); // ENOENT: normal
}

// Temporales: unlink-tras-open; barrido por edad al arranque.
export async function nuevoTemporal(prefix = 'turn') {
  await barrerHuerfanos();
  const dir = join(RUNTIME, 'tmp');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ruta = join(
    dir,
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
  );
  const h = await open(ruta, 'w', 0o600);
  return { ruta, handle: h };
}

async function barrerHuerfanos() {
  const dir = join(RUNTIME, 'tmp');
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - 60_000;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (s.mtime.getTime() < cutoff) await rm(p, { force: true });
    } catch {}
  }
}

// kill-switch: grupos hijos registrados; señal → flag + kill a grupos.
// El handler NO llama exit: el flujo en curso ve el flag, resuelve
// truncated y el proceso termina limpio (fix BLOCKER ronda 3).
const grupos = new Set();
let stopFlag = false;
let stopEpoch = 0;

export function registrarGrupo(child) {
  grupos.add(child);
  child.on('close', () => grupos.delete(child));
  return child;
}

function matarTodosLosGrupos() {
  for (const c of grupos) matarGrupo(c);
}

export function matarGrupo(child) {
  try {
    if (child?.pid) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

export function pedirStop() {
  stopEpoch++;
  stopFlag = true;
  matarTodosLosGrupos();
}
export function stopPedido() {
  return stopFlag;
}
export function stopGeneration() {
  return stopEpoch;
}
export function resetStop(expectedGeneration) {
  // Una señal llegada mientras la operación cargaba config o adquiría
  // el lock no se borra al iniciar reproducción/captura.
  if (stopEpoch === expectedGeneration) stopFlag = false;
}

// Contrato de señales: SIGINT sólo trunca (es la señal del stop
// cross-process — el flujo en curso ve el flag, resuelve truncated y el
// proceso muere limpio). SIGTERM trunca Y termina: el handler sustituye
// la terminación por defecto, así que sin exit explícito el servidor
// MCP sobrevivía a su propio shutdown (análisis 2026-10-17, H2).
let terminando = false;
export function instalarSenales() {
  process.on('SIGINT', () => {
    stopEpoch++;
    stopFlag = true;
    matarTodosLosGrupos();
  });
  process.on('SIGTERM', () => {
    if (terminando) return;
    terminando = true;
    stopEpoch++;
    stopFlag = true;
    matarTodosLosGrupos();
    // gracia para que la operación en curso asiente el truncado (escala
    // de los max_latency_ms declarados); unref: no retiene un proceso
    // que ya estaba terminando por su cuenta. Si la salida natural se
    // adelanta (EOF de stdin, fin de la operación), su exit gana sobre
    // el 143 — la spec declara ambas (ronda adversarial, H1/H2).
    const salida = setTimeout(() => process.exit(143), 250);
    salida.unref();
  });
}

// stop cross-process: señal al pid del lockfile (fix BLOCKER ronda 3,
// superficie v1 preexistente) y orden CON ACUSE a cada esperador de
// stdin por SU socket (r3, B1; r4, H-5: la lectura con pipe abierto
// también es interrumpible, sin señales a pids de terceros). Un socket
// sin receptor (proceso muerto: conectar falla) se barra aquí. Un
// socket con receptor lento que no acusa dentro del plazo no se barre
// ni cuenta: podría estar vivo y ocupado. senal_remota es true si la
// señal llegó al portador del canal o un esperador vivo ACUSÓ la orden.
export async function detenerCanalRemoto() {
  let senal = false;
  let pid = 0;
  try {
    pid = Number((await readFile(LOCK, 'utf8')).trim());
  } catch {} // sin lock: el canal está libre para reproducción
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGINT');
      senal = true;
    } catch {}
  }
  let entradas = [];
  try {
    entradas = await readdir(ESPERA);
  } catch {} // sin directorio: nadie espera
  for (const nombre of entradas) {
    if (!nombre.endsWith('.sock')) continue; // ajeno al registro
    const recibido = await ordenStopEsperador(join(ESPERA, nombre));
    if (recibido === null) continue; // vivo pero sin acuse: no tocar
    if (!recibido) {
      // huérfano: sin receptor que pueda acusar
      await unlink(join(ESPERA, nombre)).catch(() => {});
      continue;
    }
    senal = true;
  }
  return senal;
}

// Entrega la orden de stop a un socket de esperador. true = acusada por
// el receptor; false = sin receptor (conectar falló: proceso muerto o
// archivo no-socket); null = conectó pero no acuso dentro del plazo.
function ordenStopEsperador(ruta, plazoMs = 1000) {
  return new Promise((resolve) => {
    let terminado = false;
    let plazo = null;
    const socket = net.connect(ruta);
    const fin = (v) => {
      if (terminado) return;
      terminado = true;
      if (plazo) clearTimeout(plazo);
      socket.destroy();
      resolve(v);
    };
    plazo = setTimeout(() => fin(null), plazoMs);
    plazo.unref();
    socket.on('error', () => fin(false));
    socket.on('connect', () => socket.write(ORDEN_STOP));
    socket.on('data', () => fin(true));
  });
}

// spawn en su propio grupo; stderr drenado SIEMPRE (fix HIGH: pipe lleno
// → child congelado). stdin con handler EPIPE.
export function spawnGrupo(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    ...opts,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', () => {}); // drenar: contenido descartado (política logs)
  child.stdin.on('error', () => {}); // EPIPE si el hijo muere temprano
  registrarGrupo(child);
  return child;
}
