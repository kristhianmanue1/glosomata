// Contratos observables de C2: causa prudente, pid diagnóstico y duración.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeErrorCode } from '../src/error-codes.mjs';
import { measureOperation } from '../src/duration.mjs';

const dir = mkdtempSync(join(tmpdir(), 'glosomata-c2-'));
const cfg = join(dir, 'config.json');
const ffmpeg = join(dir, 'ffmpeg-fallo');
const runtime = join(dir, 'runtime');
writeFileSync(cfg, JSON.stringify({ engines: { tts: [], stt: {} } }));
writeFileSync(ffmpeg, '#!/bin/sh\nexit 7\n');
chmodSync(ffmpeg, 0o700);
process.env.GLOSOMATA_CONFIG = cfg;
process.env.GLOSOMATA_FFMPEG = ffmpeg;
process.env.GLOSOMATA_RUNTIME = runtime;

const { listen } = await import('../src/stt.mjs');
const { pedirStop, stopPedido, stopGeneration, resetStop } =
  await import('../src/canal.mjs');
const { speakCore, ttsAudioCause } = await import('../src/ops.mjs');
const lockDir = join(runtime, `glosomata-${process.getuid()}`);
const lock = join(lockDir, 'canal.lock');

after(() => rmSync(dir, { recursive: true, force: true }));

test('código imprevisto no cruza la taxonomía cerrada', () => {
  assert.equal(normalizeErrorCode('EACCES'), 'internal_error');
  assert.equal(normalizeErrorCode('channel_busy'), 'channel_busy');
});

test('stop llegado durante el arranque no se borra al adquirir el canal', () => {
  const before = stopGeneration();
  pedirStop();
  resetStop(before);
  assert.equal(stopPedido(), true);
  resetStop(stopGeneration());
  assert.equal(stopPedido(), false);
});

test('duración acompaña también un resultado satisfactorio', async () => {
  const r = await measureOperation(async () => ({ code: 0, data: { ok: true } }));
  assert.equal(r.data.ok, true);
  assert.ok(Number.isInteger(r.data.duration_ms) && r.data.duration_ms >= 0);
});

test('causa TTS sólo atribuye playback a fallo de reproducción', () => {
  assert.equal(ttsAudioCause('audio_device_error'), 'playback_failed');
  assert.equal(ttsAudioCause('tts_failed'), null);
});

test('speak fallido informa duración aunque no llegue a reproducir', async () => {
  const r = await speakCore({ text: 'hola', engine: 'inexistente' });
  assert.equal(r.data.error, 'engine_unavailable');
  assert.ok(Number.isInteger(r.data.duration_ms) && r.data.duration_ms >= 0);
});

test('listen con ffmpeg fallido informa capture_failed, no permiso', async () => {
  const r = await listen(['--timeout', '1']);
  assert.equal(r.data.error, 'audio_device_error');
  assert.equal(r.data.causa, 'capture_failed');
  assert.ok(Number.isInteger(r.data.duration_ms) && r.data.duration_ms >= 0);
});

test('listen con ffmpeg ausente identifica ffmpeg_missing', async () => {
  process.env.GLOSOMATA_FFMPEG = join(dir, 'ffmpeg-inexistente');
  try {
    const r = await listen(['--timeout', '1']);
    assert.equal(r.data.error, 'audio_device_error');
    assert.equal(r.data.causa, 'ffmpeg_missing');
    assert.ok(Number.isInteger(r.data.duration_ms));
  } finally {
    process.env.GLOSOMATA_FFMPEG = ffmpeg;
  }
});

test('WAV vacío con ffmpeg exit 0 es captura fallida, no silencio', async () => {
  writeFileSync(ffmpeg, '#!/bin/sh\nexit 0\n');
  try {
    const r = await listen(['--timeout', '1']);
    assert.equal(r.data.error, 'audio_device_error');
    assert.equal(r.data.causa, 'capture_failed');
  } finally {
    writeFileSync(ffmpeg, '#!/bin/sh\nexit 7\n');
  }
});

test('WAV eliminado por ffmpeg exit 0 es captura fallida', async () => {
  writeFileSync(ffmpeg,
    '#!/bin/sh\nfor arg do last="$arg"; done\nrm "$last"\nexit 0\n');
  try {
    const r = await listen(['--timeout', '1']);
    assert.equal(r.data.error, 'audio_device_error');
    assert.equal(r.data.causa, 'capture_failed');
  } finally {
    writeFileSync(ffmpeg, '#!/bin/sh\nexit 7\n');
  }
});

test('temporal STT inválido libera el lock aun tras error', async () => {
  mkdirSync(lockDir, { recursive: true });
  const tmp = join(lockDir, 'tmp');
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(tmp, 'no es directorio');
  try {
    const r = await listen(['--timeout', '1']);
    assert.equal(r.data.error, 'internal_error');
    assert.ok(Number.isInteger(r.data.duration_ms));
    assert.equal(existsSync(lock), false);
  } finally {
    rmSync(tmp, { force: true });
  }
});

test('whisper fallido informa causa cerrada tras captura válida', async () => {
  const wavScript = [
    '#!/usr/bin/env node',
    "const { writeFileSync } = require('node:fs');",
    'const pcm = Buffer.alloc(3200);',
    'for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);',
    'const wav = Buffer.alloc(44 + pcm.length);',
    "wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length, 4);",
    "wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);",
    'wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);',
    'wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);',
    'wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);',
    "wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);",
    'pcm.copy(wav, 44); writeFileSync(process.argv.at(-1), wav);',
  ].join('\n');
  writeFileSync(ffmpeg, `${wavScript}\n`);
  writeFileSync(cfg, JSON.stringify({ engines: { tts: [], stt: {
    whisper_bin: join(dir, 'whisper-inexistente'),
    whisper_model: join(dir, 'modelo-inexistente'),
  } } }));
  try {
    const r = await listen(['--timeout', '1']);
    assert.equal(r.data.error, 'stt_failed');
    assert.equal(r.data.causa, 'whisper_failed');
    assert.ok(Number.isInteger(r.data.duration_ms));
  } finally {
    writeFileSync(ffmpeg, '#!/bin/sh\nexit 7\n');
    writeFileSync(cfg, JSON.stringify({ engines: { tts: [], stt: {} } }));
  }
});

test('listen interrumpido conserva stopped y duration_ms', async () => {
  writeFileSync(ffmpeg, '#!/bin/sh\nsleep 5\n');
  const timer = setTimeout(pedirStop, 150);
  try {
    const r = await listen(['--timeout', '5']);
    assert.equal(r.data.error, 'stopped');
    assert.ok(Number.isInteger(r.data.duration_ms)
      && r.data.duration_ms >= 0);
  } finally {
    clearTimeout(timer);
    writeFileSync(ffmpeg, '#!/bin/sh\nexit 7\n');
  }
});

test('listen ocupado informa pid sólo para diagnóstico y duración', async () => {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(lock, String(process.pid));
  try {
    const r = await listen(['--timeout', '1']);
    assert.equal(r.data.error, 'channel_busy');
    assert.equal(r.data.busy_pid, process.pid);
    assert.ok(Number.isInteger(r.data.duration_ms) && r.data.duration_ms >= 0);
  } finally {
    rmSync(lock, { force: true });
  }
});
