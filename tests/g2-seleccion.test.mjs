// G2a/G2a2 — selección de ENTRADA por nombre exacto y preferencia en
// matriz externa. Hermético: ffmpeg y whisper FALSOS que registran su
// argv — jamás un dispositivo real (los nombres son genéricos; el grep
// de este archivo contra el listado real del host NO debe coincidir).
//
// EN PROCESO con plataforma INYECTADA (r2 del capitán): los tests de
// flujo llaman listenOp(argv, stopAtStart, {plataforma:'darwin'}) —
// así CI linux los ejerce DE VERDAD en lugar de recibir
// not_supported del process.platform real (el CLI de darwin sería
// inútil allí). La inyección es la misma que listenOp ofrece por
// contrato (mismo patrón que listarDispositivos). El parseo de flags
// se conserva: listenOp recibe el MISMO argv que el CLI pasaría tras
// separar el comando.
//
// Lo que SÍ prueba: la tubería (argv con `:<nombre>`, jamás un índice;
// validación 0/1/N/alias/charset previa e innegociable; no-fallback
// absoluto). Lo que NO prueba: el binding FÍSICO nombre→dispositivo
// dentro de AVFoundation — `inconclusive` hasta el ensayo vivo
// autorizado (contrato-hardware-v1.md).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// —— fixtures genéricos (NUNCA nombres reales del host) ——

const LISTADO = [
  '[AVFoundation indev @ 0x1] AVFoundation video devices:',
  '[AVFoundation indev @ 0x1] [0] Camara Generica',
  '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
  '[AVFoundation indev @ 0x1] [0] Entrada Cero',
  '[AVFoundation indev @ 0x1] [1] Entrada Uno',
  '[AVFoundation indev @ 0x1] [2] Entrada Doble',
  '[AVFoundation indev @ 0x1] [3] Entrada Doble',
  '',
  '[in#0 @ 0x1] Error opening input: Input/output error',
  'Error opening input file .',
].join('\n');

// ffmpeg falso: registra CADA invocación (una línea JSON de argv por
// fila) en GLO_G2_ARGV_LOG — variable que el listado de variables
// contractuales NO declara porque src/ jamás la lee: la lee este
// binario de prueba. `-list_devices` → listado y exit I/O error
// DESPUÉS de listar (comportamiento observado; decisión por contenido).
// Captura de `:0` o de cualquier `:Entrada …` del fixture → WAV s16le
// mono 16 kHz válido, exit 0 (el binding real lo decide AVFoundation
// al abrir, no este binario). Cualquier otra captura → exit 1 ruidoso.
const CUERPO_FFMPEG = `
const fs = require('fs');
const argv = process.argv.slice(2);
const log = process.env.GLO_G2_ARGV_LOG;
if (log) fs.appendFileSync(log, JSON.stringify(argv) + '\\n');
if (argv.includes('-list_devices')) {
  process.stderr.write(${JSON.stringify(LISTADO)} + '\\n');
  process.exit(251);
}
const iIn = argv.indexOf('-i');
const input = argv[iIn + 1];
if (input === ':0'
    || (typeof input === 'string' && input.startsWith(':Entrada'))) {
  const sr = 16000, n = 8000;
  const pcm = Buffer.alloc(n * 2);
  for (let j = 0; j < n; j++) pcm.writeInt16LE(5000, j * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(argv[argv.length - 1], Buffer.concat([h, pcm]));
  process.exit(0);
}
process.exit(1);
`;

const CUERPO_FFMPEG_BASURA = `
const fs = require('fs');
const log = process.env.GLO_G2_ARGV_LOG;
if (log) fs.appendFileSync(log,
  JSON.stringify(process.argv.slice(2)) + '\\n');
process.stderr.write('basura\\nsin seccion\\n');
process.exit(1);
`;

const CUERPO_WHISPER = `process.stdout.write('hola\\n');process.exit(0);`;

const dir = mkdtempSync(join(tmpdir(), 'glosomata-g2-'));
const runtime = mkdtempSync(join(tmpdir(), 'glosomata-g2-rt-'));
const log = join(dir, 'argv.log');
after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(runtime, { recursive: true, force: true });
});

function falso(nombre, cuerpo) {
  const ruta = join(dir, nombre);
  writeFileSync(ruta, `#!/usr/bin/env node\n${cuerpo}\n`);
  chmodSync(ruta, 0o755);
  return ruta;
}

const ffmpegFalso = falso('ffmpeg-falso', CUERPO_FFMPEG);
const ffmpegBasura = falso('ffmpeg-basura', CUERPO_FFMPEG_BASURA);
const whisperFalso = falso('whisper-falso', CUERPO_WHISPER);

// Config fixture de RUTA ÚNICA: matriz.mjs congela la ruta al importar
// (GLOSOMATA_CONFIG se lee una vez), así que los escenarios mutan el
// CONTENIDO de este mismo archivo, nunca la ruta.
const cfgFija = join(dir, 'glosomata-fixture.json');
function escribirConfig(extraStt = {}) {
  writeFileSync(cfgFija, JSON.stringify({
    engines: { tts: [], stt: { whisper_bin: whisperFalso,
      whisper_model: whisperFalso, ...extraStt } },
    constraints: {},
  }));
}

// Entorno ANTES de importar src/: canal.mjs congela RUNTIME y
// matriz.mjs congela RUTA_CONFIG al cargar el módulo.
process.env.GLOSOMATA_CONFIG = cfgFija;
process.env.GLOSOMATA_RUNTIME = runtime;
process.env.GLOSOMATA_FFMPEG = ffmpegFalso;
process.env.GLO_G2_ARGV_LOG = log;

const { listenOp } = await import('../src/ops.mjs');

function resetLog() {
  rmSync(log, { force: true });
}

function invocaciones() {
  return existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => l)
      .map((l) => JSON.parse(l))
    : [];
}

// Escenario darwin INYECTADO: el flujo corre igual en darwin y en CI
// linux (listenOp nunca consulta process.platform aquí).
async function escuchar(args, { ffmpeg, stt = {} } = {}) {
  escribirConfig(stt);
  resetLog();
  const previo = process.env.GLOSOMATA_FFMPEG;
  process.env.GLOSOMATA_FFMPEG = ffmpeg ?? ffmpegFalso;
  try {
    return await listenOp(args, 0,
      { plataforma: 'darwin', detalleNombres: true });
  } finally {
    process.env.GLOSOMATA_FFMPEG = previo;
  }
}

// Ninguna invocación registrada puede capturar `:0` ni un índice
// desnudo — la propiedad central del no-fallback (G2a §3).
function sinFallbackNiIndice(invs, etiqueta) {
  for (const a of invs) {
    assert.ok(!a.includes(':0'), `${etiqueta}: ffmpeg invocado con :0`);
    const iIn = a.indexOf('-i');
    if (iIn >= 0 && a[iIn + 1] !== undefined) {
      assert.ok(!/^:\d+$/.test(a[iIn + 1]),
        `${etiqueta}: input por índice: ${a[iIn + 1]}`);
    }
  }
}

// —— petición explícita (--device) ——

test('G2a: --device ausente en listado → device_missing, sin capturar', async () => {
  const r = await escuchar(['--device', 'Entrada Fantasma']);
  assert.equal(r.code, 1);
  assert.equal(r.data.error, 'audio_device_error');
  assert.equal(r.data.causa, 'device_missing');
  // detalle de nombres SÓLO con detalleNombres (canal local)
  assert.deepEqual(r.data.detalle.disponibles,
    ['Entrada Cero', 'Entrada Uno', 'Entrada Doble', 'Entrada Doble']);
  const invs = invocaciones();
  // sólo la sonda de listado corrió: la captura jamás se invoca
  assert.ok(invs.every((a) => a.includes('-list_devices')));
  sinFallbackNiIndice(invs, 'ausente');
});

test('G2a: homónimos → device_missing fail-closed con conteo, sin adivinar', async () => {
  const r = await escuchar(['--device', 'Entrada Doble']);
  assert.equal(r.code, 1);
  assert.equal(r.data.error, 'audio_device_error');
  assert.equal(r.data.causa, 'device_missing');
  assert.equal(r.data.detalle, 'nombre ambiguo: 2 coincidencias');
  const invs = invocaciones();
  assert.ok(invs.every((a) => a.includes('-list_devices')));
  sinFallbackNiIndice(invs, 'homonimos');
});

test('G2a: nombre único → captura con :nombre exacto, jamás índice', async () => {
  const r = await escuchar(['--device', 'Entrada Uno']);
  assert.equal(r.code, 0);
  assert.equal(r.data.transcript, 'hola');
  const invs = invocaciones();
  assert.equal(invs.length, 2); // listado + captura
  assert.ok(invs[0].includes('-list_devices'));
  const iIn = invs[1].indexOf('-i');
  assert.equal(invs[1][iIn + 1], ':Entrada Uno');
  sinFallbackNiIndice(invs, 'unico');
});

test('G2a: `--device` sin valor → usage, jamás captura de `:0`', async () => {
  const r = await escuchar(['--device']);
  assert.equal(r.code, 2);
  assert.equal(r.data.error, 'usage');
  assert.equal(existsSync(log), false, 'ffmpeg invocado sin valor de --device');
});

test('G2a: forma inválida → usage ANTES de invocar ffmpeg para nada', async () => {
  for (const mala of ['', 'default', 'none', 'a:b', 'con "comillas"',
    "con 'comillas'"]) {
    const r = await escuchar(['--device', mala]);
    assert.equal(r.code, 2, JSON.stringify(mala));
    assert.equal(r.data.error, 'usage');
    assert.equal(existsSync(log), false,
      `${JSON.stringify(mala)}: ffmpeg invocado con forma inválida`);
  }
});

test('G2a: listado ilegible → device_list_unavailable, sin abrir mic', async () => {
  const r = await escuchar(['--device', 'Entrada Uno'],
    { ffmpeg: ffmpegBasura });
  assert.equal(r.code, 1);
  assert.equal(r.data.error, 'audio_device_error');
  assert.equal(r.data.causa, 'device_list_unavailable');
  // ni ausencia (device_missing) ni captura (capture_failed)
  assert.equal(r.data.detalle, undefined);
  const invs = invocaciones();
  assert.ok(invs.every((a) => a.includes('-list_devices')),
    'el ffmpeg de captura NO se invoca para nada');
  sinFallbackNiIndice(invs, 'ilegible');
});

// —— preferencia implícita (G2a2, matriz externa por GLOSOMATA_CONFIG) ——

test('G2a2: preferencia resuelve → captura con :nombre, sin --device', async () => {
  const r = await escuchar([], { stt: { input_device: 'Entrada Uno' } });
  assert.equal(r.code, 0);
  assert.equal(r.data.transcript, 'hola');
  const invs = invocaciones();
  const iIn = invs[invs.length - 1].indexOf('-i');
  assert.equal(invs[invs.length - 1][iIn + 1], ':Entrada Uno');
  sinFallbackNiIndice(invs, 'preferencia-ok');
});

test('G2a2: preferencia ausente → device_missing, JAMÁS :0 en silencio', async () => {
  const r = await escuchar([], { stt: { input_device: 'Entrada Fantasma' } });
  assert.equal(r.code, 1);
  assert.equal(r.data.causa, 'device_missing');
  const invs = invocaciones();
  assert.ok(invs.every((a) => a.includes('-list_devices')));
  sinFallbackNiIndice(invs, 'preferencia-ausente');
});

test('G2a2: preferencia ambigua → device_missing con conteo', async () => {
  const r = await escuchar([], { stt: { input_device: 'Entrada Doble' } });
  assert.equal(r.code, 1);
  assert.equal(r.data.detalle, 'nombre ambiguo: 2 coincidencias');
  sinFallbackNiIndice(invocaciones(), 'preferencia-ambigua');
});

test('G2a2: listado ilegible con preferencia → device_list_unavailable', async () => {
  const r = await escuchar([], { ffmpeg: ffmpegBasura,
    stt: { input_device: 'Entrada Uno' } });
  assert.equal(r.code, 1);
  assert.equal(r.data.causa, 'device_list_unavailable');
  assert.ok(invocaciones().every((a) => a.includes('-list_devices')),
    'el ffmpeg de captura NO se invoca para nada');
});

test('G2a/G2a2: precedencia — --device gana a la preferencia', async () => {
  const r = await escuchar(['--device', 'Entrada Cero'],
    { stt: { input_device: 'Entrada Uno' } });
  assert.equal(r.code, 0);
  const invs = invocaciones();
  const iIn = invs[invs.length - 1].indexOf('-i');
  assert.equal(invs[invs.length - 1][iIn + 1], ':Entrada Cero');
});

test('G2a: sin petición ni preferencia → conducta original intacta (:0)', async () => {
  const r = await escuchar([]);
  assert.equal(r.code, 0);
  assert.equal(r.data.transcript, 'hola');
  const invs = invocaciones();
  const captura = invs[invs.length - 1];
  const iIn = captura.indexOf('-i');
  assert.equal(captura[iIn + 1], ':0'); // el :0 legítimo de la vía default
});

// —— plataforma sin la selección (inyección hermética) ——

test('G2a: linux con nombre → not_supported, ffmpeg jamás invocado', async () => {
  escribirConfig();
  resetLog();
  const r = await listenOp(['--device', 'Entrada Uno'], 0,
    { plataforma: 'linux' });
  assert.equal(r.code, 1);
  assert.equal(r.data.error, 'not_supported');
  // el ffmpeg de captura NO se invoca para nada en este fallo
  assert.equal(existsSync(log), false);
});
