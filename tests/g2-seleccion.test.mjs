// G2a/G2a2 — selección de ENTRADA por nombre exacto y preferencia en
// matriz externa. Hermético: ffmpeg y whisper FALSOS que registran su
// argv — jamás un dispositivo real (los nombres son genéricos; el grep
// de este archivo contra el listado real del host NO debe coincidir).
//
// Lo que SÍ prueba: la tubería (argv con `:<nombre>`, jamás un índice;
// validación 0/1/N/alias/charset previa e innegociable; no-fallback
// absoluto). Lo que NO prueba: el binding FÍSICO nombre→dispositivo
// dentro de AVFoundation — `inconclusive` hasta el ensayo vivo
// autorizado (contrato-hardware-v1.md).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RAIZ = new URL('..', import.meta.url).pathname;
const CLI = 'src/cli.mjs';

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
// Captura de `:Entrada Uno` → WAV s16le mono 16 kHz válido, exit 0.
// Cualquier otra captura → exit 1 (fallo ruidoso).
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
// ':0' incluido: la vía SIN petición sigue siendo legítima (conducta
// original intacta); el no-fallback se prueba en las peticiones.
// Cualquier nombre del fixture genérico captura: el binding real lo
// decide AVFoundation al abrir, no este binario de prueba.
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
after(() => rmSync(dir, { recursive: true, force: true }));

function falso(nombre, cuerpo) {
  const ruta = join(dir, nombre);
  writeFileSync(ruta, `#!/usr/bin/env node\n${cuerpo}\n`);
  chmodSync(ruta, 0o755);
  return ruta;
}

const ffmpegFalso = falso('ffmpeg-falso', CUERPO_FFMPEG);
const ffmpegBasura = falso('ffmpeg-basura', CUERPO_FFMPEG_BASURA);
const whisperFalso = falso('whisper-falso', CUERPO_WHISPER);

function configCon(extraStt = {}) {
  const ruta = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(ruta, JSON.stringify({
    engines: { tts: [], stt: { whisper_bin: whisperFalso,
      whisper_model: whisperFalso, ...extraStt } },
    constraints: {},
  }));
  return ruta;
}

function escuchar(args, { ffmpeg = ffmpegFalso, cfg = configCon() } = {}) {
  const runtime = mkdtempSync(join(tmpdir(), 'glosomata-g2-rt-'));
  const log = join(runtime, 'argv.log');
  const r = spawnSync('node', [CLI, 'listen', ...args], {
    encoding: 'utf8', cwd: RAIZ, timeout: 30_000,
    env: { ...process.env, GLOSOMATA_CONFIG: cfg,
      GLOSOMATA_RUNTIME: runtime, GLOSOMATA_FFMPEG: ffmpeg,
      GLO_G2_ARGV_LOG: log },
  });
  return { ...r, log, runtime };
}

function invocaciones(log) {
  return existsSync(log)
    ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => l)
      .map((l) => JSON.parse(l))
    : [];
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

test('G2a: --device ausente en listado → device_missing, sin capturar', () => {
  const r = escuchar(['--device', 'Entrada Fantasma']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /audio_device_error/);
  assert.match(r.stderr, /device_missing/);
  // detalle de nombres SÓLO en CLI (canal local del Operador)
  assert.match(r.stderr, /disponibles/);
  assert.match(r.stderr, /Entrada Cero/);
  const invs = invocaciones(r.log);
  // sólo la sonda de listado corrió: la captura jamás se invoca
  assert.ok(invs.every((a) => a.includes('-list_devices')));
  sinFallbackNiIndice(invs, 'ausente');
});

test('G2a: homónimos → device_missing fail-closed con conteo, sin adivinar', () => {
  const r = escuchar(['--device', 'Entrada Doble']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /device_missing/);
  assert.match(r.stderr, /nombre ambiguo: 2 coincidencias/);
  const invs = invocaciones(r.log);
  assert.ok(invs.every((a) => a.includes('-list_devices')));
  sinFallbackNiIndice(invs, 'homonimos');
});

test('G2a: nombre único → captura con :nombre exacto, jamás índice', () => {
  const r = escuchar(['--device', 'Entrada Uno']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.transcript, 'hola');
  const invs = invocaciones(r.log);
  assert.equal(invs.length, 2); // listado + captura
  assert.ok(invs[0].includes('-list_devices'));
  const iIn = invs[1].indexOf('-i');
  assert.equal(invs[1][iIn + 1], ':Entrada Uno');
  sinFallbackNiIndice(invs, 'unico');
});

test('G2a: forma inválida → usage ANTES de invocar ffmpeg para nada', () => {
  for (const mala of ['', 'default', 'none', 'a:b', 'con "comillas"',
    "con 'comillas'"]) {
    const r = escuchar(['--device', mala]);
    assert.equal(r.status, 2, `${JSON.stringify(mala)}: ${r.stderr}`);
    assert.match(r.stderr, /usage/);
    assert.equal(existsSync(r.log), false,
      `${JSON.stringify(mala)}: ffmpeg invocado con forma inválida`);
  }
});

test('G2a: listado ilegible → device_list_unavailable, sin abrir mic', () => {
  const r = escuchar(['--device', 'Entrada Uno'], { ffmpeg: ffmpegBasura });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /audio_device_error/);
  assert.match(r.stderr, /device_list_unavailable/);
  // ni ausencia (device_missing) ni captura (capture_failed)
  assert.equal(r.stderr.includes('device_missing'), false);
  assert.equal(r.stderr.includes('disponibles'), false);
  const invs = invocaciones(r.log);
  assert.ok(invs.every((a) => a.includes('-list_devices')),
    'el ffmpeg de captura NO se invoca para nada');
  sinFallbackNiIndice(invs, 'ilegible');
});
// —— preferencia implícita (G2a2, matriz externa por GLOSOMATA_CONFIG) ——

test('G2a2: preferencia resuelve → captura con :nombre, sin --device', () => {
  const cfg = configCon({ input_device: 'Entrada Uno' });
  const r = escuchar([], { cfg });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).transcript, 'hola');
  const invs = invocaciones(r.log);
  const iIn = invs[invs.length - 1].indexOf('-i');
  assert.equal(invs[invs.length - 1][iIn + 1], ':Entrada Uno');
  sinFallbackNiIndice(invs, 'preferencia-ok');
});

test('G2a2: preferencia ausente → device_missing, JAMÁS :0 en silencio', () => {
  const cfg = configCon({ input_device: 'Entrada Fantasma' });
  const r = escuchar([], { cfg });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /device_missing/);
  const invs = invocaciones(r.log);
  assert.ok(invs.every((a) => a.includes('-list_devices')));
  sinFallbackNiIndice(invs, 'preferencia-ausente');
});

test('G2a2: preferencia ambigua → device_missing con conteo', () => {
  const cfg = configCon({ input_device: 'Entrada Doble' });
  const r = escuchar([], { cfg });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /nombre ambiguo: 2 coincidencias/);
  sinFallbackNiIndice(invocaciones(r.log), 'preferencia-ambigua');
});

test('G2a2: listado ilegible con preferencia → device_list_unavailable', () => {
  const cfg = configCon({ input_device: 'Entrada Uno' });
  const r = escuchar([], { ffmpeg: ffmpegBasura, cfg });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /device_list_unavailable/);
  assert.ok(invocaciones(r.log).every((a) => a.includes('-list_devices')),
    'el ffmpeg de captura NO se invoca para nada');
});

test('G2a/G2a2: precedencia — --device gana a la preferencia', () => {
  const cfg = configCon({ input_device: 'Entrada Uno' });
  const r = escuchar(['--device', 'Entrada Cero'], { cfg });
  assert.equal(r.status, 0, r.stderr);
  const invs = invocaciones(r.log);
  const iIn = invs[invs.length - 1].indexOf('-i');
  assert.equal(invs[invs.length - 1][iIn + 1], ':Entrada Cero');
});

test('G2a: sin petición ni preferencia → conducta original intacta (:0)', () => {
  const r = escuchar([]);
  assert.equal(r.status, 0, r.stderr);
  const invs = invocaciones(r.log);
  const captura = invs[invs.length - 1];
  const iIn = captura.indexOf('-i');
  assert.equal(captura[iIn + 1], ':0'); // el :0 legítimo de la vía default
});

// —— plataforma sin la selección (inyección hermética, en proceso) ——

test('G2a: linux con nombre → not_supported, ffmpeg jamás invocado', async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'glosomata-g2-rt-'));
  const log = join(runtime, 'argv.log');
  process.env.GLOSOMATA_CONFIG = configCon();
  process.env.GLOSOMATA_RUNTIME = runtime;
  process.env.GLOSOMATA_FFMPEG = ffmpegFalso;
  process.env.GLO_G2_ARGV_LOG = log;
  try {
    const { listenOp } = await import('../src/ops.mjs');
    const r = await listenOp(['--device', 'Entrada Uno'], 0,
      { plataforma: 'linux' });
    assert.equal(r.code, 1);
    assert.equal(r.data.error, 'not_supported');
    // el ffmpeg de captura NO se invoca para nada en este fallo
    assert.equal(existsSync(log), false);
  } finally {
    delete process.env.GLOSOMATA_CONFIG;
    delete process.env.GLOSOMATA_RUNTIME;
    delete process.env.GLOSOMATA_FFMPEG;
    delete process.env.GLO_G2_ARGV_LOG;
    rmSync(runtime, { recursive: true, force: true });
  }
});
