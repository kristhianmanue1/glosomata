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
const authPath = join(dir, 'auth-glosomata.txt');
// Credencial de prueba (el "token" es un valor fijo de test, no un
// secreto): mismas dos cabeceras que exige SPEC-i2 §2.1.
writeFileSync(authPath,
  'Authorization: Bearer token-fijo-de-test\nX-Project-ID: glosomata\n');
chmodSync(authPath, 0o600);

// Emula el contrato de stdout de curl con -w '\n%{http_code}': CUERPO +
// salto de línea + código de 3 dígitos. El texto privado JAMÁS viaja en
// argv (misma frontera que el adaptador exige de verdad).
writeFileSync(fakeCurl, `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks);
if (process.argv.some((arg) => arg.includes('texto privado'))) process.exit(8);
if (!process.argv.some((arg) => arg.includes('127.0.0.1:8092'))) process.exit(9);
// Frontera de autenticación (SPEC-i2 §2.1-2.2): 401 sin Authorization
// Bearer; 400 con Authorization pero sin X-Project-ID; 403
// project_mismatch si el proyecto no es el registrado; autorizado sólo
// con ambos correctos.
const idxHeader = process.argv.indexOf('--header');
let proyecto = null;
let conBearer = false;
if (idxHeader >= 0 && String(process.argv[idxHeader + 1]).startsWith('@')) {
  try {
    const fs2 = await import('node:fs');
    const credenciales =
      fs2.readFileSync(String(process.argv[idxHeader + 1]).slice(1), 'utf8');
    conBearer = /^Authorization:\\s*Bearer\\s+\\S+/m.test(credenciales);
    proyecto = /^X-Project-ID:\\s*(\\S+)/m.exec(credenciales)?.[1] ?? null;
  } catch {}
}
const emitir = (cuerpo, codigo = '200') => {
  process.stdout.write(cuerpo);
  process.stdout.write('\\n' + codigo);
};
if (!conBearer) {
  emitir(JSON.stringify({ error: { code: 'missing_token' } }), '401');
  process.exit(0);
}
if (proyecto === null) {
  emitir(JSON.stringify({ error: { code: 'missing_project_id' } }), '400');
  process.exit(0);
}
if (proyecto !== 'glosomata') {
  emitir(JSON.stringify({ error: { code: 'project_mismatch' } }), '403');
  process.exit(0);
}
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
  auth_file: authPath,
  selected: false, kill_switch: { type: 'subprocess_kill',
    target: 'process_group', max_latency_ms: 500 } };

// Un requester que rechaza si lo llaman: acredita que la validación de
// entrada falla ANTES de solicitar (sin request, sin round-trip).
const requesterProhibido = () =>
  Promise.reject(new Error('no debe solicitar'));

test('schema admite LFM3 como motor con auth_file', () => {
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

test('probe exige credencial 0600 con estructura válida', async (t) => {
  if (process.platform !== 'darwin') return t.skip('lfm3 reproduce con afplay (macOS)');
  const { diagnostico, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  const request = createRequesterForTesting(fakeCurl);
  // sin auth_file declarado → causa estructural propia
  const { auth_file, ...sinAuth } = motor;
  assert.equal(auth_file, authPath); // fixture completa
  assert.deepEqual(await diagnostico(sinAuth, request),
    { ok: false, causa: 'auth_ausente' });
  // ruta inexistente → auth_ausente
  assert.deepEqual(await diagnostico({ ...motor, auth_file: '/no/existe' },
    request), { ok: false, causa: 'auth_ausente' });
  // permisos distintos de 0600 → auth_ausente
  const perms0644 = join(dir, 'auth-0644.txt');
  writeFileSync(perms0644,
    'Authorization: Bearer x\nX-Project-ID: glosomata\n');
  chmodSync(perms0644, 0o644);
  assert.deepEqual(await diagnostico({ ...motor, auth_file: perms0644 },
    request), { ok: false, causa: 'auth_ausente' });
  // archivo vacío → auth_ausente
  const vacio = join(dir, 'auth-vacio.txt');
  writeFileSync(vacio, '');
  chmodSync(vacio, 0o600);
  assert.deepEqual(await diagnostico({ ...motor, auth_file: vacio },
    request), { ok: false, causa: 'auth_ausente' });
  // tamaño fuera de cota (4097 bytes) → auth_ausente
  const gigante = join(dir, 'auth-gigante.txt');
  writeFileSync(gigante, 'x'.repeat(4097));
  chmodSync(gigante, 0o600);
  assert.deepEqual(await diagnostico({ ...motor, auth_file: gigante },
    request), { ok: false, causa: 'auth_ausente' });
  // un directorio no es archivo de credencial → auth_ausente
  assert.deepEqual(await diagnostico({ ...motor, auth_file: dir },
    request), { ok: false, causa: 'auth_ausente' });
  // estructura válida pero credencial rechazada por el gateway (400):
  // causa de probe, no estructural
  const sinProyecto = join(dir, 'auth-sin-proyecto.txt');
  writeFileSync(sinProyecto, 'Authorization: Bearer token-fijo-de-test\n');
  chmodSync(sinProyecto, 0o600);
  assert.deepEqual(await diagnostico({ ...motor, auth_file: sinProyecto },
    request), { ok: false, causa: 'probe_fallido' });
  // proyecto registrado distinto → 403 project_mismatch → probe_fallido
  const otroProyecto = join(dir, 'auth-otro-proyecto.txt');
  writeFileSync(otroProyecto,
    'Authorization: Bearer token-fijo-de-test\nX-Project-ID: otro\n');
  chmodSync(otroProyecto, 0o600);
  assert.deepEqual(await diagnostico({ ...motor, auth_file: otroProyecto },
    request), { ok: false, causa: 'probe_fallido' });
});

test('síntesis rechazada por el gateway muere con el código del rechazo', async () => {
  const { sintetizar, createRequesterForTesting } =
    await import('../src/tts/lfm3.mjs');
  const request = createRequesterForTesting(fakeCurl);
  // sin auth_file la petición sale SIN credencial: la rechaza el
  // gateway (401), no una validación local — documentado, fail-closed.
  const { auth_file, ...sinAuth } = motor;
  assert.equal(auth_file, authPath);
  await assert.rejects(sintetizar(sinAuth, 'texto privado', wavPath,
    request), (error) => error.code === 'tts_failed'
      && error.cause === 'http_401');
  // Authorization sin X-Project-ID → 400 missing_project_id
  const sinProyecto = join(dir, 'auth-sin-proyecto.txt');
  writeFileSync(sinProyecto, 'Authorization: Bearer token-fijo-de-test\n');
  chmodSync(sinProyecto, 0o600);
  await assert.rejects(sintetizar({ ...motor, auth_file: sinProyecto },
    'texto privado', wavPath, request),
    (error) => error.code === 'tts_failed' && error.cause === 'http_400');
  // proyecto que no es el registrado → 403 project_mismatch
  const otroProyecto = join(dir, 'auth-otro-proyecto.txt');
  writeFileSync(otroProyecto,
    'Authorization: Bearer token-fijo-de-test\nX-Project-ID: otro\n');
  chmodSync(otroProyecto, 0o600);
  await assert.rejects(sintetizar({ ...motor, auth_file: otroProyecto },
    'texto privado', wavPath, request),
    (error) => error.code === 'tts_failed' && error.cause === 'http_403');
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
