// Regresiones de la ronda adversarial 5: WAV real (H-1), guard de stop
// en captura (M-1), robo atómico del lock (M-2), red de kokoro (M-4),
// texto '--' vía MCP (M-5), config sin estructura (M-6), TTL (L-3),
// probes honestos (L-1) y STT curado en engines.
// Aislamiento: este archivo corre en su propio proceso (node --test),
// con config y runtime temporales propios.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, rmSync, mkdirSync, accessSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirCfg = mkdtempSync(join(tmpdir(), 'glosomata-r5-cfg-'));
const dirRun = mkdtempSync(join(tmpdir(), 'glosomata-r5-run-'));
writeFileSync(join(dirCfg, 'cfg.json'), JSON.stringify({
  engines: { tts: [], stt: {} },
  constraints: { session_ttl_min: 7 },
}));
process.env.GLOSOMATA_CONFIG = join(dirCfg, 'cfg.json');
process.env.GLOSOMATA_RUNTIME = dirRun;

const { pcmDesdeWav } = await import('../src/stt.mjs');
const { adquirirCanal, liberarCanal } = await import('../src/canal.mjs');
const { speakMcp, enginesOp } = await import('../src/ops.mjs');
const { sessionData } = await import('../src/sesion.mjs');
const { cargarMatriz } = await import('../src/matriz.mjs');
const kokoro = await import('../src/tts/kokoro.mjs');

const LOCK = join(dirRun, `glosomata-${process.getuid()}`, 'canal.lock');

after(() => {
  rmSync(dirCfg, { recursive: true, force: true });
  rmSync(dirRun, { recursive: true, force: true });
});

// —— H-1: el header de ffmpeg NO es de 44 bytes ——

function chunk(id, cuerpo) {
  const h = Buffer.alloc(8);
  h.write(id, 0, 'latin1');
  h.writeUInt32LE(cuerpo.length, 4);
  return Buffer.concat([h, cuerpo, cuerpo.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

test('ronda5/H-1: pcmDesdeWav con header clásico de 44 bytes', () => {
  const fmt = chunk('fmt ', Buffer.alloc(16));
  const pcm = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const data = chunk('data', pcm);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4),
    Buffer.from('WAVE'), fmt, data]);
  assert.deepEqual(pcmDesdeWav(wav), pcm);
});

test('ronda5/H-1: LIST INFOISFT desplaza data a offset 70 (caso ffmpeg real)', () => {
  const fmt = chunk('fmt ', Buffer.alloc(16));
  const list = chunk('LIST', Buffer.alloc(26, 0x41)); // 26 bytes ASCII basura
  const pcm = Buffer.alloc(3200, 0); // silencio real
  const data = chunk('data', pcm);
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4),
    Buffer.from('WAVE'), fmt, list, data]);
  const out = pcmDesdeWav(wav);
  // el bug subarray(44) incluía la basura del header: RMS 176 en silencio
  assert.equal(out.length, pcm.length);
  assert.equal(out.every((b) => b === 0), true);
});

test('ronda5/H-1: WAV ilegible → null (fail-closed)', () => {
  assert.equal(pcmDesdeWav(Buffer.alloc(100, 7)), null); // sin RIFF
  assert.equal(pcmDesdeWav(Buffer.from('RIFF____WAVE__nochunks')), null);
});

// —— M-2: robo del lock ——

test('ronda5/M-2: lock stale con pid muerto se roba y libera', async () => {
  const muerto = spawnSync('true'); // hijo reaped: pid garantizado muerto
  mkdirSync(join(dirRun, `glosomata-${process.getuid()}`), { recursive: true });
  writeFileSync(LOCK, String(muerto.pid));
  await adquirirCanal(); // roba, no channel_busy
  await liberarCanal();
});

test('ronda5/M-2: lock con pid vivo → channel_busy', async () => {
  writeFileSync(LOCK, String(process.pid));
  await assert.rejects(adquirirCanal(), (e) => e.code === 'channel_busy');
  rmSync(LOCK, { force: true });
});

// —— M-5: texto legítimo que inicia con '--' ——

test('ronda5/M-5: speakMcp con text "--help…" no es usage falso', async () => {
  const r = await speakMcp({ text: '--help no es un comando', engine: 'no-existe' });
  assert.equal(r.code, 1);
  assert.equal(r.data.error, 'engine_unavailable'); // antes: usage
});

// —— M-6: config sin estructura ——

test('ronda5/M-6: config sin engines → config_unreadable, no TypeError', async () => {
  const vacio = join(dirCfg, 'vacio.json');
  writeFileSync(vacio, '{}');
  await assert.rejects(cargarMatriz(vacio),
    (e) => e.code === 'config_unreadable');
  const sinStt = join(dirCfg, 'sin-stt.json');
  writeFileSync(sinStt, JSON.stringify({ engines: { tts: [] } }));
  await assert.rejects(cargarMatriz(sinStt),
    (e) => e.code === 'config_unreadable');
});

// —— L-3: TTL desde constraints ——

test('ronda5/L-3: session new usa constraints.session_ttl_min (7, no 15)', async () => {
  const r = await sessionData(['new']);
  assert.equal(r.code, 0);
  assert.equal(r.data.ttl_min, 7);
});

// —— L-1 + STT curado ——

test('ronda5/L-1: kokoro sin model no está disponible (sin red)', async () => {
  const r = await kokoro.disponible({
    python: '.venv/bin/python',
    script: 'src/tts/synthesize_kokoro.py',
  });
  assert.equal(r, false);
});

test('ronda5/L-1: kokoro con model local (dir) disponible en darwin', async (t) => {
  if (process.platform !== 'darwin') t.skip('afplay es darwin');
  const dirModelo = mkdtempSync(join(tmpdir(), 'r5-modelo-'));
  const r = await kokoro.disponible({
    python: process.execPath, // cualquier ejecutable existente sirve al probe
    script: 'src/tts/synthesize_kokoro.py',
    model: dirModelo,
  });
  rmSync(dirModelo, { recursive: true, force: true });
  assert.equal(r, true);
});

test('ronda5: engines no expone rutas del STT, sólo disponibilidad', async () => {
  const r = await enginesOp();
  assert.equal(r.code, 0);
  assert.equal(r.data.stt.available, false); // stt {} → sin bins
  assert.ok(!('whisper_bin' in r.data.stt));
  assert.ok(!('whisper_model' in r.data.stt));
});

// —— M-4: script py exige model local (bloqueo de red en la fuente) ——

test('ronda5/M-4: synthesize_kokoro.py sin model → input_invalid sin importar mlx', async (t) => {
  try {
    accessSync('.venv/bin/python');
  } catch {
    t.skip('sin .venv/bin/python');
    return;
  }
  const r = spawnSync('.venv/bin/python', ['src/tts/synthesize_kokoro.py'], {
    input: JSON.stringify({ texto: 'hola', out: '/tmp/no.wav' }),
    encoding: 'utf8',
  });
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, false);
  assert.equal(out.error, 'input_invalid');
});
