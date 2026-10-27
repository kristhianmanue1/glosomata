// Contrato observable del adaptador experimental Phonon/Ollama.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync,
  existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync as read } from 'node:fs';
import { validar } from '../src/schema.mjs';

const schema = JSON.parse(read(new URL('../docs/schemas/glosomata-config-v1.schema.json',
  import.meta.url), 'utf8'));
const dir = mkdtempSync(join(tmpdir(), 'glosomata-phonon-'));
const fakeCurl = join(dir, 'curl');
const wavPath = join(dir, 'out.wav');

writeFileSync(fakeCurl, `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (process.argv.some((arg) => arg.includes('texto privado'))) process.exit(8);
if (!process.argv.some((arg) => arg.includes('127.0.0.1:11434'))) process.exit(9);
if (process.argv.at(-1).endsWith('/api/show')) {
  process.stdout.write(JSON.stringify({ capabilities: ['speech'],
    voices: ['default', 'Rebeca', 'Lalo'] }));
} else if (process.argv.at(-1).endsWith('/v1/audio/speech')) {
  if (body.input !== 'texto privado' || body.voice !== 'Rebeca') process.exit(10);
  if (process.env.FAKE_PHONON_SLOW === '1') {
    const fs = await import('node:fs');
    fs.writeFileSync(process.env.FAKE_PHONON_STARTED, String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (process.env.FAKE_PHONON_BAD_WAV === '1') {
    process.stdout.write('not audio');
  } else {
    const pcm = Buffer.alloc(4800, 1);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0); wav.writeUInt32LE(0xffffffff, 4);
    wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(0xffffffff, 40);
    pcm.copy(wav, 44);
    process.stdout.write(wav);
  }
} else process.exit(11);
`);
chmodSync(fakeCurl, 0o700);
test.after(() => rmSync(dir, { recursive: true, force: true }));

const motor = { id: 'phonon-rebeca', adapter: 'phonon_ollama',
  model: 'phonon-es-mx-eval-20261027', voice: 'Rebeca',
  selected: false, kill_switch: { type: 'subprocess_kill',
    target: 'process_group', max_latency_ms: 500 } };

test('schema admite Phonon/Ollama como motor no seleccionado', () => {
  const cfg = { engines: { tts: [{ id: 'say', adapter: 'say',
    selected: true, kill_switch: { type: 'subprocess_kill',
      target: 'process_group', max_latency_ms: 200 } }, motor], stt: {} } };
  assert.deepEqual(validar(cfg, schema), []);
});

test('probe valida capacidad speech y voz registrada', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Phonon en Ollama requiere macOS');
  const { diagnostico, createRequesterForTesting } =
    await import('../src/tts/phonon_ollama.mjs');
  const request = createRequesterForTesting(fakeCurl);
  assert.deepEqual(await diagnostico(motor, request), { ok: true });
  assert.deepEqual(await diagnostico({ ...motor, voice: 'NoExiste' }, request),
    { ok: false, causa: 'probe_fallido' });
  assert.deepEqual(await diagnostico({ ...motor, bin: fakeCurl }, request),
    { ok: false, causa: 'probe_fallido' });
});

test('síntesis pasa texto por stdin y acepta WAV streaming de Ollama', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/phonon_ollama.mjs');
  assert.equal(await sintetizar(motor, 'texto privado', wavPath,
    createRequesterForTesting(fakeCurl)), 'ok');
  const wav = readFileSync(wavPath);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 4844);
});

test('WAV inválido falla cerrado', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/phonon_ollama.mjs');
  process.env.FAKE_PHONON_BAD_WAV = '1';
  try {
    await assert.rejects(sintetizar(motor, 'texto privado', wavPath,
      createRequesterForTesting(fakeCurl)),
      (error) => error.code === 'tts_failed');
  } finally {
    delete process.env.FAKE_PHONON_BAD_WAV;
  }
});

test('stop corta subprocess de síntesis ya iniciado', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/phonon_ollama.mjs');
  const { pedirStop, resetStop, stopGeneration } =
    await import('../src/canal.mjs');
  const marker = join(dir, 'curl-active.pid');
  process.env.FAKE_PHONON_SLOW = '1';
  process.env.FAKE_PHONON_STARTED = marker;
  const start = Date.now();
  const pending = sintetizar(motor, 'texto privado', wavPath,
    createRequesterForTesting(fakeCurl));
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(marker), true, 'curl inició la síntesis');
  try {
    pedirStop();
    assert.equal(await pending, 'stopped');
    assert.ok(Date.now() - start < 3000, 'se cortó antes de terminar solo');
  } finally {
    resetStop(stopGeneration());
    delete process.env.FAKE_PHONON_SLOW;
    delete process.env.FAKE_PHONON_STARTED;
  }
});
