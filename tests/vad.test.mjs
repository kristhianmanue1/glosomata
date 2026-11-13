// VAD en listen: cierre y limpieza (revisiones r1/r2 del 2026-11-13).
// ffmpeg y vad_bin falsos: sin micrófono ni modelos reales.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync, readdirSync, readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'glosomata-vad-'));
const runtime = join(dir, 'runtime');
const cfg = join(dir, 'config.json');
const ffmpeg = join(dir, 'ffmpeg-falso');
const vadBin = join(dir, 'vad-lento');
const vadModel = join(dir, 'modelo.bin');
const pidVad = join(dir, 'vad.pid');

// Emite 1.5 s de tono a stdout cada 100 ms y escribe el WAV (último arg).
writeFileSync(ffmpeg, [
  '#!/usr/bin/env node',
  "const fs = require('node:fs');",
  'const tramo = Buffer.alloc(3200);',
  'for (let i = 0; i < 3200; i += 2) tramo.writeInt16LE(3000, i);',
  'let n = 0;',
  'const iv = setInterval(() => {',
  '  process.stdout.write(tramo);',
  '  if (++n < 15) return;',
  '  clearInterval(iv);',
  '  const pcm = Buffer.concat(Array(n).fill(tramo));',
  '  const h = Buffer.alloc(44);',
  "  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4);",
  "  h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);",
  '  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);',
  '  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28);',
  '  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);',
  "  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);",
  '  fs.writeFileSync(process.argv.at(-1), Buffer.concat([h, pcm]));',
  '}, 100);',
].join('\n') + '\n');
chmodSync(ffmpeg, 0o700);
// VAD lento: anota su pid y duerme más que la captura.
writeFileSync(vadBin, `#!/bin/sh\necho $$ > ${pidVad}\nexec sleep 30\n`);
chmodSync(vadBin, 0o700);
writeFileSync(vadModel, 'x');
writeFileSync(cfg, JSON.stringify({ engines: { tts: [], stt: {
  whisper_bin: join(dir, 'whisper-inexistente'),
  whisper_model: join(dir, 'modelo-inexistente'),
  vad_bin: vadBin, vad_model: vadModel,
} } }));
process.env.GLOSOMATA_CONFIG = cfg;
process.env.GLOSOMATA_FFMPEG = ffmpeg;
process.env.GLOSOMATA_RUNTIME = runtime;
process.env.GLOSOMATA_TONO = '';

const { listen } = await import('../src/stt.mjs');

after(() => rmSync(dir, { recursive: true, force: true }));

const vivo = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('VAD lento en vuelo: listen vuelve sin .vad.wav ni proceso VAD vivo', async () => {
  const t0 = Date.now();
  const r = await listen(['--timeout', '10']);
  const ms = Date.now() - t0;
  // la captura termina sola (1.5 s); whisper inexistente → stt_failed
  assert.equal(r.data.error, 'stt_failed');
  assert.ok(ms < 5000, `listen tardó ${ms} ms esperando al VAD`);
  assert.ok(existsSync(pidVad), 'el VAD llegó a lanzarse');
  const pid = Number(readFileSync(pidVad, 'utf8'));
  await new Promise((res) => setTimeout(res, 100));
  assert.equal(vivo(pid), false, 'proceso VAD huérfano');
  const tmp = join(runtime, 'tmp');
  const restos = existsSync(tmp) ? readdirSync(tmp) : [];
  assert.deepEqual(restos.filter((f) => f.endsWith('.vad.wav')), []);
});

test('VAD declarado y roto: listen cae al detector RMS sin fallar', async () => {
  const roto = JSON.parse(readFileSync(cfg, 'utf8'));
  roto.engines.stt.vad_model = join(dir, 'no-existe.bin');
  const cfgRoto = join(dir, 'config-roto.json');
  writeFileSync(cfgRoto, JSON.stringify(roto));
  process.env.GLOSOMATA_CONFIG = cfgRoto;
  try {
    const r = await listen(['--timeout', '10']);
    // pasó captura y puerta RMS: el fallo es del whisper inexistente
    assert.equal(r.data.error, 'stt_failed');
  } finally {
    process.env.GLOSOMATA_CONFIG = cfg;
  }
});
