// Contrato observable del adaptador LFM3-Omni (boca, gateway 8092).
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
const dir = mkdtempSync(join(tmpdir(), 'glosomata-lfm3-'));
const fakeCurl = join(dir, 'curl');
const wavPath = join(dir, 'out.wav');

// Emula el contrato de stdout de curl con -w '\n%{http_code}': CUERPO +
// salto de línea + código de 3 dígitos. El texto privado JAMÁS viaja en
// argv (misma frontera que el adaptador exige de verdad).
writeFileSync(fakeCurl, `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks);
if (process.argv.some((arg) => arg.includes('texto privado'))) process.exit(8);
if (!process.argv.some((arg) => arg.includes('127.0.0.1:8092'))) process.exit(9);
const emitir = (cuerpo, codigo = '200') => {
  process.stdout.write(cuerpo);
  process.stdout.write('\\n' + codigo);
};
const ruta = process.argv.at(-1);
if (ruta.endsWith('/v1/capabilities')) {
  if (process.env.FAKE_LFM3_SIN_VOZ === '1') {
    emitir(JSON.stringify({ voz: false }));
  } else {
    emitir(JSON.stringify({ entrada: ['texto', 'imagen', 'audio'],
      salida: ['texto', 'audio'], transcripcion: true, voz: true,
      audio: true, streaming: false, video: false }));
  }
} else if (ruta.endsWith('/v1/audio/speech')) {
  const body = JSON.parse(stdin.toString('utf8'));
  // El contrato del body es EXACTO (SPEC-i1-vs §1): input +
  // response_format. Una regresión que añada una clave (p. ej. voice,
  // que el gateway rechaza con 400) debe romper aquí, no en producción.
  const claves = Object.keys(body).sort().join(',');
  if (claves !== 'input,response_format') process.exit(12);
  if (body.input !== 'texto privado' || body.response_format !== 'wav') {
    process.exit(10);
  }
  if (process.env.FAKE_LFM3_SLOW === '1') {
    const fs = await import('node:fs');
    fs.writeFileSync(process.env.FAKE_LFM3_STARTED, String(process.pid));
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (process.env.FAKE_LFM3_503 === '1') {
    emitir('{"error":{"code":"overloaded"}}', '503');
  } else if (process.env.FAKE_LFM3_BAD_WAV === '1') {
    emitir('not audio');
  } else if (process.env.FAKE_LFM3_TRUNC === '1') {
    // 200 con bytes arbitrarios: fmt declarado (16) pero payload
    // ausente tras un chunk LIST — el caso RangeError de la revisión.
    const wav = Buffer.alloc(52);
    wav.write('RIFF', 0); wav.writeUInt32LE(44, 4);
    wav.write('WAVE', 8);
    wav.write('LIST', 12); wav.writeUInt32LE(24, 16);
    wav.write('fmt ', 44); wav.writeUInt32LE(16, 48);
    emitir(wav);
  } else if (process.env.FAKE_LFM3_DATA_MIENTE === '1') {
    // data declara 4800 muestras pero entrega 10 bytes
    const wav = Buffer.alloc(62);
    wav.write('RIFF', 0); wav.writeUInt32LE(54, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(4800, 40);
    wav.fill(1, 44, 54);
    emitir(wav);
  } else {
    const pcm = Buffer.alloc(4800, 1);
    const wav = Buffer.alloc(44 + pcm.length);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
    wav.write('WAVE', 8);
    wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(pcm.length, 40);
    pcm.copy(wav, 44);
    emitir(wav);
  }
} else process.exit(11);
`);
chmodSync(fakeCurl, 0o700);
test.after(() => rmSync(dir, { recursive: true, force: true }));

const motor = { id: 'lfm3-es', adapter: 'lfm3',
  selected: false, kill_switch: { type: 'subprocess_kill',
    target: 'process_group', max_latency_ms: 500 } };

// Un requester que rechaza si lo llaman: acredita que la validación de
// entrada falla ANTES de solicitar (sin request, sin round-trip).
const requesterProhibido = () =>
  Promise.reject(new Error('no debe solicitar'));

test('schema admite LFM3 como motor sin claves propias', () => {
  const cfg = { engines: { tts: [{ id: 'say', adapter: 'say',
    selected: true, kill_switch: { type: 'subprocess_kill',
      target: 'process_group', max_latency_ms: 200 } }, motor], stt: {} } };
  assert.deepEqual(validar(cfg, schema), []);
});

test('probe exige capabilities con voz true', async (t) => {
  if (process.platform !== 'darwin') return t.skip('lfm3 reproduce con afplay (macOS)');
  const { diagnostico, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  const request = createRequesterForTesting(fakeCurl);
  assert.deepEqual(await diagnostico(motor, request), { ok: true });
  process.env.FAKE_LFM3_SIN_VOZ = '1';
  try {
    assert.deepEqual(await diagnostico(motor, request),
      { ok: false, causa: 'probe_fallido' });
  } finally {
    delete process.env.FAKE_LFM3_SIN_VOZ;
  }
  assert.deepEqual(await diagnostico({ ...motor, bin: fakeCurl }, request),
    { ok: false, causa: 'probe_fallido' });
});

test('síntesis pasa texto por stdin y escribe WAV del gateway', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  assert.equal(await sintetizar(motor, 'texto privado', wavPath,
    createRequesterForTesting(fakeCurl)), 'ok');
  const wav = readFileSync(wavPath);
  assert.equal(wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(34), 16); // 16 bits
  assert.equal(wav.length, 4844);
});

test('entrada fuera del contrato del motor se rechaza sin solicitar', async () => {
  const { sintetizar } = await import('../src/tts/lfm3.mjs');
  const casos = [
    ['línea con salto\nno soportada', 'not_supported'],
    ['texto con\ttab', 'not_supported'],
    ['texto con\u007fDEL', 'not_supported'],
    ['   ', 'not_supported'],
    ['', 'not_supported'],
    ['x'.repeat(601), 'text_too_long'],
  ];
  for (const [texto, codigo] of casos) {
    await assert.rejects(sintetizar(motor, texto, wavPath, requesterProhibido),
      (error) => error.code === codigo, `caso ${JSON.stringify(texto.slice(0, 20))}`);
  }
});

test('cuenta code points, no unidades UTF-16 (cota 600 del proveedor)', async () => {
  const { sintetizar } = await import('../src/tts/lfm3.mjs');
  // 350 emojis = 350 code points = 700 unidades UTF-16: dentro de la
  // cota del proveedor; con métrica UTF-16 rechazaría aquí. Que el
  // rechazo llegue DESDE el requester acredita que la validación pasó.
  const alcanzaRequester = (error) => error.message === 'no debe solicitar';
  await assert.rejects(sintetizar(motor, '🙋'.repeat(350), wavPath,
    requesterProhibido), alcanzaRequester);
  // frontera exacta: 600 code points pasan, 601 no.
  await assert.rejects(sintetizar(motor, 'x'.repeat(600), wavPath,
    requesterProhibido), alcanzaRequester);
  await assert.rejects(sintetizar(motor, 'x'.repeat(601), wavPath,
    requesterProhibido), (error) => error.code === 'text_too_long');
});

test('503 overloaded falla cerrado como tts_failed', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  process.env.FAKE_LFM3_503 = '1';
  try {
    await assert.rejects(sintetizar(motor, 'texto privado', wavPath,
      createRequesterForTesting(fakeCurl)),
      (error) => error.code === 'tts_failed' && error.cause === 'http_503');
  } finally {
    delete process.env.FAKE_LFM3_503;
  }
});

test('WAV inválido falla cerrado', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  process.env.FAKE_LFM3_BAD_WAV = '1';
  try {
    await assert.rejects(sintetizar(motor, 'texto privado', wavPath,
      createRequesterForTesting(fakeCurl)),
      (error) => error.code === 'tts_failed');
  } finally {
    delete process.env.FAKE_LFM3_BAD_WAV;
  }
});

test('WAV truncado o con data mentiroso falla tts_failed, no internal_error', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  for (const flag of ['FAKE_LFM3_TRUNC', 'FAKE_LFM3_DATA_MIENTE']) {
    process.env[flag] = '1';
    try {
      await assert.rejects(sintetizar(motor, 'texto privado', wavPath,
        createRequesterForTesting(fakeCurl)),
        (error) => error.code === 'tts_failed', flag);
    } finally {
      delete process.env[flag];
    }
  }
});

test('stop corta subprocess de síntesis ya iniciado', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  const { pedirStop, resetStop, stopGeneration } =
    await import('../src/canal.mjs');
  const marker = join(dir, 'curl-active.pid');
  process.env.FAKE_LFM3_SLOW = '1';
  process.env.FAKE_LFM3_STARTED = marker;
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
    delete process.env.FAKE_LFM3_SLOW;
    delete process.env.FAKE_LFM3_STARTED;
  }
});
