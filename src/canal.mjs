// Canal half-duplex v1 — lockfile atómico (O_EXCL), temporales 0700,
// kill-switch por señal cross-process. Contrato: docs/specs/.

import { open, mkdir, rm, readdir, rename, stat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

// GLOSOMATA_RUNTIME aísla el dir de lock/temporales (tests paralelos de la
// suite comparten $TMPDIR con otros procesos de la misma corrida).
const RUNTIME = process.env.GLOSOMATA_RUNTIME
  ? join(process.env.GLOSOMATA_RUNTIME, `glosomata-${process.getuid?.() ?? 'u'}`)
  : join(tmpdir(), `glosomata-${process.getuid?.() ?? 'u'}`);
const LOCK = join(RUNTIME, 'canal.lock');

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
  stopFlag = true;
  matarTodosLosGrupos();
}
export function stopPedido() {
  return stopFlag;
}
export function resetStop() {
  stopFlag = false;
}

export function instalarSenales() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopFlag = true;
      matarTodosLosGrupos();
    });
  }
}

// stop cross-process: señal al pid del lockfile (fix BLOCKER ronda 3).
export async function detenerCanalRemoto() {
  let pid = 0;
  try {
    pid = Number((await readFile(LOCK, 'utf8')).trim());
  } catch {
    return false; // sin lock: canal libre
  }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 'SIGINT');
    return true;
  } catch {
    return false;
  }
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
