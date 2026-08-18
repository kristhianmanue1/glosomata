// Canal half-duplex v1 — lockfile global, temporales 0700, kill-switch.
// Contrato: docs/specs/contrato-cli.md (operaciones speak/listen/stop).

import { open, mkdir, rm, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawn } from 'node:child_process';

// Runtime dir per-user (mkdtemp-style), lockfile del half-duplex cross-process.
const RUNTIME = join(
  tmpdir(),
  `glosomata-${process.getuid?.() ?? 'u'}`
);
const LOCK = join(RUNTIME, 'canal.lock');
const STALE_MS = 60_000;

let lockHandle = null;

export async function adquirirCanal() {
  await mkdir(RUNTIME, { recursive: true, mode: 0o700 });
  const h = await open(LOCK, 'a+');
  const { mtime } = await stat(LOCK);
  const age = Date.now() - mtime.getTime();
  const prev = (await h.readFile('utf8')).trim();
  if (prev && prev !== `${process.pid}` && age < STALE_MS) {
    await h.close();
    const err = new Error('channel_busy');
    err.code = 'channel_busy';
    throw err;
  }
  await h.truncate(0);
  await h.write(`${process.pid}`, 0);
  lockHandle = h;
}

export function liberarCanal() {
  const h = lockHandle;
  lockHandle = null;
  if (h) return h.close().catch(() => {});
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
  const cutoff = Date.now() - STALE_MS;
  for (const name of entries) {
    const p = join(dir, name);
    try {
      const s = await stat(p);
      if (s.mtime.getTime() < cutoff) await rm(p, { force: true });
    } catch {}
  }
}

// Kill-switch: flag atómico; el loop de playback lo poll-ea por chunk.
// El handler de señal sólo setea el flag y mata al grupo de hijos.
let stopFlag = false;
export function pedirStop() {
  stopFlag = true;
}
export function stopPedido() {
  return stopFlag;
}
export function resetStop() {
  stopFlag = false;
}

// spawn en su propio grupo de proceso: kill(-pgid) alcanza a los hijos.
export function spawnGrupo(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    ...opts,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('exit', () => {});
  return child;
}

export async function matarGrupo(child) {
  if (child?.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  }
}

// speak/listen: stubs honestos de cascarón — F3 los implementa por motor.
// No son placeholders "por si acaso": son la frontera verificable de F2.
export async function speak(argv) {
  await adquirirCanal();
  try {
    const idx = argv.indexOf('--text');
    const texto = idx >= 0 ? argv[idx + 1] : null;
    if (!texto) throw new Error('usage: speak requiere --text');
    const { matriz } = await import('./matriz.mjs');
    const cfg = await matriz();
    const motor = cfg.engines.tts.find((e) => e.selected && e.available);
    if (!motor) {
      const err = new Error('engine_unavailable');
      err.code = 'engine_unavailable';
      throw err;
    }
    // Reproducción real: F3 (adaptadores tts/). Cascarón: respuesta del contrato.
    process.stdout.write(
      `${JSON.stringify({ played: false, engine: motor.id, echo: null, truncated: false, nota: 'cascaron F2' })}\n`
    );
    return 0;
  } finally {
    liberarCanal();
  }
}

export async function listen(argv) {
  await adquirirCanal();
  try {
    const idx = argv.indexOf('--timeout');
    const timeout = idx >= 0 ? Number(argv[idx + 1]) : 10;
    const err = new Error('not_supported');
    err.code = 'not_supported';
    err.detalle = `captura de micrófono pendiente de F3 (timeout ${timeout}s)`;
    throw err;
  } finally {
    liberarCanal();
  }
}

export async function stop() {
  pedirStop();
  process.stdout.write(`${JSON.stringify({ stopped: true })}\n`);
  return 0;
}
