// Contrato observable de la capa de TOKENS del artefacto
// services/stt-turbo: formatos por línea (claro O sha256 hex de 64),
// mixtos, rotación con formatos distintos y cruce declarado. La suite
// principal del artefacto vive en tests/stt-turbo.test.mjs; ésta nace
// aparte por el límite de 800 líneas del gate (precedente diar).
// Hermético igual que la hermana: hijo FALSO en loopback, tokens en
// tmp, cerrojo desactivado.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, chmodSync, rmSync }
  from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { crearServidor } from '../services/stt-turbo/servidor.mjs';

const TOKEN_A = 'token-falso-a-4f1c';
const TOKEN_B = 'token-falso-b-9d27';
const TRANSCRIPCION = 'transcripcion fija del hijo falso';
const sha256 = (texto) =>
  createHash('sha256').update(texto, 'utf8').digest('hex');

const dir = mkdtempSync(join(tmpdir(), 'glosomata-stt-turbo-tok-'));

// WAV RIFF PCM 16 kHz mono s16le mínimo para pasar la validación.
function hacerWav(duracionS) {
  const dataBytes = Math.round(duracionS * 32000);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);    // PCM
  buf.writeUInt16LE(1, 22);    // mono
  buf.writeUInt32LE(16000, 24);
  buf.writeUInt32LE(32000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}
const wavValidoB64 = hacerWav(0.5).toString('base64');

const cuerpoChat = (wavB64) => ({
  model: 'el-que-tequio-mande',
  messages: [{
    role: 'user',
    content: [
      { type: 'input_audio',
        input_audio: { data: wavB64, format: 'wav' } },
    ],
  }],
});

// Hijo falso: cuenta solicitudes (para afirmar que un 401 NO consume
// inferencia) y responde texto fijo.
async function crearHijoFalso() {
  const estado = { solicitudes: 0 };
  const server = http.createServer((req, res) => {
    const trozos = [];
    req.on('data', (t) => trozos.push(t));
    req.on('end', () => {
      if (req.method !== 'POST') {
        res.writeHead(200);
        res.end('ok');
        return;
      }
      estado.solicitudes += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: TRANSCRIPCION }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { estado, url: `http://127.0.0.1:${server.address().port}`,
    cerrar: () => new Promise((resolve) => server.close(resolve)) };
}

// Servidor en proceso con tokensRuta propio e hijo falso adoptado.
async function arrancar(tokensRuta) {
  const hijo = await crearHijoFalso();
  const srv = crearServidor(
    { STT_TURBO_TOKENS: tokensRuta, STT_TURBO_LOCK: 'none' },
    { upstreamBase: hijo.url });
  await srv.iniciar();
  await new Promise((resolve) => srv.server.listen(0, '127.0.0.1', resolve));
  return { hijo, url: `http://127.0.0.1:${srv.server.address().port}`,
    cerrar: async () => { await hijo.cerrar(); await srv.cerrar(); } };
}

async function post(url, cuerpo, { token = TOKEN_A, proyecto = 'tequio' } = {}) {
  const res = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(proyecto === null ? {} : { 'x-project-id': proyecto }),
    },
    body: JSON.stringify(cuerpo),
  });
  const texto = await res.text();
  return { estado: res.status, texto };
}

const demora = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const escribirTokens = (ruta, ...valores) => {
  writeFileSync(ruta, valores.join('\n') + '\n');
  chmodSync(ruta, 0o600);
};

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('línea hash: autentica al token, JAMÁS al propio hash presentado',
  async () => {
    const ruta = join(dir, 'tokens-sha');
    escribirTokens(ruta, sha256(TOKEN_A));
    const { url, hijo, cerrar } = await arrancar(ruta);
    try {
      // El token cuya línea es su sha256: 200.
      assert.equal((await post(url, cuerpoChat(wavValidoB64))).estado, 200);
      // Token equivocado: 401 byte-exacto, igual que en claro.
      const mal = await post(url, cuerpoChat(wavValidoB64),
        { token: 'token-equivocado-0000' });
      assert.equal(mal.estado, 401);
      assert.equal(mal.texto, '{"error":{"code":"unauthorized"}}');
      // Presentar el PROPIO hash como Bearer no autentica: la línea es
      // el sha del token, no un token.
      const propio = await post(url, cuerpoChat(wavValidoB64),
        { token: sha256(TOKEN_A) });
      assert.equal(propio.estado, 401);
      // Proyecto distinto sigue cayendo en el mismo 401.
      const proj = await post(url, cuerpoChat(wavValidoB64),
        { proyecto: 'otro-proyecto' });
      assert.equal(proj.estado, 401);
      assert.equal(proj.texto, '{"error":{"code":"unauthorized"}}');
      // Ningún fallo consumió inferencia.
      assert.equal(hijo.estado.solicitudes, 1);
    } finally { await cerrar(); }
  });

test('MIXTO: claro y sha256 conviven en el mismo archivo', async () => {
  const ruta = join(dir, 'tokens-mixtos');
  escribirTokens(ruta, sha256(TOKEN_B), TOKEN_A);
  const { url, cerrar } = await arrancar(ruta);
  try {
    assert.equal((await post(url, cuerpoChat(wavValidoB64),
      { token: TOKEN_A })).estado, 200); // línea clara
    assert.equal((await post(url, cuerpoChat(wavValidoB64),
      { token: TOKEN_B })).estado, 200); // línea hash
    assert.equal((await post(url, cuerpoChat(wavValidoB64),
      { token: 'token-ni-a-ni-b-0000' })).estado, 401);
  } finally { await cerrar(); }
});

test('rotación sin hueco con formatos distintos: claro → mixto → hash',
  async () => {
    const ruta = join(dir, 'tokens-rotacion-formatos');
    escribirTokens(ruta, TOKEN_A);
    const { url, cerrar } = await arrancar(ruta);
    try {
      assert.equal((await post(url, cuerpoChat(wavValidoB64))).estado, 200);
      assert.equal((await post(url, cuerpoChat(wavValidoB64),
        { token: TOKEN_B })).estado, 401); // aún no dado de alta
      // Paso 1: nuevo arriba EN HASH, viejo en claro en gracia.
      escribirTokens(ruta, sha256(TOKEN_B), TOKEN_A);
      await demora(10);
      assert.equal((await post(url, cuerpoChat(wavValidoB64),
        { token: TOKEN_B })).estado, 200); // nuevo (hash)
      assert.equal((await post(url, cuerpoChat(wavValidoB64),
        { token: TOKEN_A })).estado, 200); // viejo en gracia (claro)
      // Paso 3: se retira el viejo; queda sólo el hash.
      escribirTokens(ruta, sha256(TOKEN_B));
      await demora(10);
      assert.equal((await post(url, cuerpoChat(wavValidoB64),
        { token: TOKEN_A })).estado, 401);
      assert.equal((await post(url, cuerpoChat(wavValidoB64),
        { token: TOKEN_B })).estado, 200);
    } finally { await cerrar(); }
  });

test('cruce declarado: 64 hex clasifica hash; sha en MAYÚSCULAS, claro',
  async () => {
    const ruta = join(dir, 'tokens-cruce');
    // Un token claro que ES exactamente 64 hex: la línea clasifica
    // como hash y el token claro de esa línea NO autentica (límite
    // declarado en el README, pineado aquí para que no derive).
    const tokenHex = sha256('semilla-del-cruce');
    escribirTokens(ruta, tokenHex);
    const { url, cerrar } = await arrancar(ruta);
    try {
      const r = await post(url, cuerpoChat(wavValidoB64),
        { token: tokenHex });
      assert.equal(r.estado, 401);
      assert.equal(r.texto, '{"error":{"code":"unauthorized"}}');
    } finally { await cerrar(); }
    // MAYÚSCULAS no casa con el regex: la línea pasa por token CLARO
    // — no autentica al token real, pero presentar la propia cadena
    // en mayúsculas SÍ autentica (línea clara como otra). Pineado para
    // que la advertencia del README no derive.
    const mayus = sha256(TOKEN_A).toUpperCase();
    escribirTokens(ruta, mayus);
    const { url: url2, cerrar: cerrar2 } = await arrancar(ruta);
    try {
      assert.equal((await post(url2, cuerpoChat(wavValidoB64))).estado, 401);
      const r2 = await post(url2, cuerpoChat(wavValidoB64),
        { token: mayus });
      assert.equal(r2.estado, 200);
    } finally { await cerrar2(); }
  });

test('perms abiertos con formato hash: 401 y recuperación por chmod',
  async () => {
    const ruta = join(dir, 'tokens-perms-hash');
    writeFileSync(ruta, sha256(TOKEN_A) + '\n');
    chmodSync(ruta, 0o644);
    const { url, cerrar } = await arrancar(ruta);
    try {
      // El gate de perms es previo al parseo: el formato no importa,
      // pero el contrato «perms => lista vacía => 401» se pinea
      // también con líneas hash.
      assert.equal((await post(url, cuerpoChat(wavValidoB64))).estado, 401);
      chmodSync(ruta, 0o600);
      assert.equal((await post(url, cuerpoChat(wavValidoB64))).estado, 200);
      chmodSync(ruta, 0o644);
      assert.equal((await post(url, cuerpoChat(wavValidoB64))).estado, 401);
    } finally { await cerrar(); }
  });
