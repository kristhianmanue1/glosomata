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
  if (h) {
    return h.truncate(0)
      .catch(() => {})
      .finally(() => h.close().catch(() => {}));
  }
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

// kill-switch: registro global de grupos hijos activos. El handler de
// señal (async-signal-safe: sólo kill y flag) mata a TODOS los grupos;
// el polling de cada adaptador ve el flag y resuelve truncated.
const grupos = new Set();

export function registrarGrupo(child) {
  grupos.add(child);
  child.on('exit', () => grupos.delete(child));
  return child;
}

export function matarTodosLosGrupos() {
  for (const c of grupos) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGKILL');
    } catch {}
  }
}

let stopFlag = false;
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

// Handler de señal: async-signal-safe — sólo flag + kill. Nada de teardown
// de CoreAudio/MLX aquí (hallazgo BLOCKER ronda 2).
export function instalarSenales() {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      stopFlag = true;
      matarTodosLosGrupos();
      process.exit(130);
    });
  }
}

// spawn en su propio grupo de proceso: kill(-pgid) alcanza a los hijos.
export function spawnGrupo(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    ...opts,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registrarGrupo(child);
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

// speak: reproduce texto por el motor seleccionado (adaptadores tts/).
export async function speak(argv) {
  await adquirirCanal();
  resetStop();
  try {
    const idx = argv.indexOf('--text');
    let texto = idx >= 0 ? argv[idx + 1] : null;
    const eIdx = argv.indexOf('--engine');
    const cfg = await cargarMatriz();
    const motor =
      (eIdx >= 0 && cfg.engines.tts.find((e) => e.id === argv[eIdx + 1] && e.available)) ||
      cfg.engines.tts.find((e) => e.selected && e.available);
    if (!motor) {
      const err = new Error('engine_unavailable');
      err.code = 'engine_unavailable';
      throw err;
    }
    texto = canonizar(texto, cfg.constraints?.max_text_chars ?? 2000);
    const adaptador = await import(`./tts/${motor.adapter}.mjs`);
    let tmpWav = null;
    if (motor.adapter !== 'say') {
      const t = await nuevoTemporal('tts');
      await t.handle.close();
      tmpWav = t.ruta;
    }
    try {
      const out = await adaptador.hablar(motor, texto, { tmpWav });
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return out.played ? 0 : 1;
    } finally {
      if (tmpWav) await rm(tmpWav, { force: true });
    }
  } finally {
    liberarCanal();
  }
}

import { cargarMatriz } from './matriz.mjs';
import { canonizar } from './plantillas.mjs';

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
