// Inventario de dispositivos (G0+G1): parsers puros contra fixtures
// REALES + bordes, op con plataforma inyectable y binarios falsos
// (hermético: corre igual en CI linux sin macOS), CLI y taxonomía.
// Jamás abre un dispositivo real: las sondas son de sólo lectura.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseListadoFfmpeg, parseSystemProfilerJson,
  listarDispositivos } from '../src/devices.mjs';
import { normalizeErrorCode } from '../src/error-codes.mjs';

const RAIZ = new URL('..', import.meta.url).pathname;
const CLI = 'src/cli.mjs';

// Fixtures REALES capturados por la sonda de sólo lectura (2026-11-11,
// saneados de nombres personales — ver informe del mandato).
const listadoReal = readFileSync(
  new URL('./fixtures/devices-ffmpeg.txt', import.meta.url), 'utf8');
const spReal = readFileSync(
  new URL('./fixtures/devices-systemprofiler.json', import.meta.url), 'utf8');

// —— listado sintético para exactitud del parser (sin acoplarse a
// nombres de hardware): el vídeo se ignora, el audio se extrae entero
const LISTADO_SINTETICO = [
  '[AVFoundation indev @ 0x1] AVFoundation video devices:',
  '[AVFoundation indev @ 0x1] [0] Cámara Video',
  '[AVFoundation indev @ 0x1] [1] Capture screen 0',
  '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
  '[AVFoundation indev @ 0x1] [0] Entrada Cero',
  '[AVFoundation indev @ 0x1] [1] Entrada Uno',
  '',
  '[in#0 @ 0x1] Error opening input: Input/output error',
  'Error opening input file .',
].join('\n');

const SP_SINTETICO = JSON.stringify({
  SPAudioDataType: [{ _name: 'audio', _items: [
    { _name: 'Salida Del So', coreaudio_device_output: 2,
      coreaudio_default_audio_output_device: 'spaudio_yes' },
    { _name: 'Entrada Del So', coreaudio_device_input: 1,
      coreaudio_default_audio_input_device: 'spaudio_yes' },
    { _name: 'Neutra', coreaudio_device_output: 2 },
  ] }],
});

// —— parsers puros: nunca throw, ilegible → null (fail-closed)

// Expectativas LITERALES leídas a mano de los fixtures (prohibido
// derivarlas llamando al propio parser — corrección del capitán):
//   devices-ffmpeg.txt: 3 dispositivos de audio tras el prefijo de log
//   '[AVFoundation indev @ 0x…] [N] Nombre' bajo la sección de audio;
//   el vídeo (Cámara FaceTime HD, Capture screen 0/1) se ignora, y las
//   líneas de error '[in#0 @ ...]' y 'Error opening input...' no cuentan.
//   devices-systemprofiler.json: 6 items; defaults del SO en
//   'Micrófono del MacBook Air' (entrada) y 'Altavoces del MacBook Air'
//   (salida); el tercer item lleva nombre SANITIZADO (redacción
//   genérica del original personal — ver informe del mandato).

test('parseListadoFfmpeg: fixture real — 3 audio, vídeo y errores fuera', () => {
  assert.deepEqual(parseListadoFfmpeg(listadoReal), [
    { id: '0', name: 'Jump Desktop Audio' },
    { id: '1', name: 'Micrófono del MacBook Air' },
    { id: '2', name: 'Jump Desktop Microphone' },
  ]);
});

test('parseListadoFfmpeg: exacto — vídeo ignorado, audio entero', () => {
  assert.deepEqual(parseListadoFfmpeg(LISTADO_SINTETICO), [
    { id: '0', name: 'Entrada Cero' },
    { id: '1', name: 'Entrada Uno' },
  ]);
});

test('parseListadoFfmpeg: bordes → null sin throw', () => {
  for (const borde of [null, undefined, 42, '', '   ',
    'basura sin secciones',
    // sólo vídeo: sin sección de audio el listado entero es ilegible
    '[AVFoundation indev @ 0x1] AVFoundation video devices:\n'
      + '[AVFoundation indev @ 0x1] [0] Cámara Video\n',
    // sección de audio presente pero sin entradas legibles
    'AVFoundation audio devices:\n\nnada entre lineas\n']) {
    assert.equal(parseListadoFfmpeg(borde), null,
      JSON.stringify(String(borde).slice(0, 40)));
  }
});

test('parseSystemProfilerJson: fixture real — 6 items, flags literales', () => {
  assert.deepEqual(parseSystemProfilerJson(spReal), [
    { name: 'TYPEC', default_input: false, default_output: false },
    { name: 'Micrófono de teléfono móvil',
      default_input: false, default_output: false },
    { name: 'Micrófono del MacBook Air',
      default_input: true, default_output: false },
    { name: 'Altavoces del MacBook Air',
      default_input: false, default_output: true },
    { name: 'Jump Desktop Microphone',
      default_input: false, default_output: false },
    { name: 'Jump Desktop Audio',
      default_input: false, default_output: false },
  ]);
});

test('parseSystemProfilerJson: exacto — tres items, flags correctos', () => {
  assert.deepEqual(parseSystemProfilerJson(SP_SINTETICO), [
    { name: 'Salida Del So', default_input: false, default_output: true },
    { name: 'Entrada Del So', default_input: true, default_output: false },
    { name: 'Neutra', default_input: false, default_output: false },
  ]);
});

test('parseSystemProfilerJson: bordes → null sin throw', () => {
  for (const borde of [null, undefined, 42, '', '  ',
    'no-json{', 'null', '[]', '{}',
    '{"SPAudioDataType":[]}',
    '{"SPAudioDataType":[{}]}',              // sin _items
    '{"SPAudioDataType":[{"_items":[]}]}',   // _items vacío
    '{"SPAudioDataType":[{"_items":[{"_name":""}]}]}',
    '{"SPAudioDataType":[{"_items":[null]}]}',
    '{"SPAudioDataType":[{"_items":[42]}]}',
  ]) {
    assert.equal(parseSystemProfilerJson(borde), null,
      JSON.stringify(String(borde).slice(0, 40)));
  }
});

test('devices_unavailable sobrevive normalizeErrorCode', () => {
  assert.equal(normalizeErrorCode('devices_unavailable'),
    'devices_unavailable');
  assert.equal(normalizeErrorCode('otro_inventado'), 'internal_error');
});

// —— op con binarios falsos: hermético en cualquier plataforma

const dirFalsos = mkdtempSync(join(tmpdir(), 'glosomata-devices-'));
after(() => rmSync(dirFalsos, { recursive: true, force: true }));

function falso(nombre, cuerpo) {
  const ruta = join(dirFalsos, nombre);
  writeFileSync(ruta, `#!/usr/bin/env node\n${cuerpo}\n`);
  chmodSync(ruta, 0o755);
  return ruta;
}

const ffmpegFalso = falso('ffmpeg-falso',
  `process.stderr.write(${JSON.stringify(listadoReal)});process.exit(251);`);
const ffmpegBasura = falso('ffmpeg-basura',
  `process.stderr.write('basura\\nsin seccion\\n');process.exit(1);`);
const ffmpegDormilon = falso('ffmpeg-dormilon',
  `setTimeout(() => process.exit(251), 3000);`);
const ffmpegAusente = join(dirFalsos, 'inexistente-ffmpeg');
const spFalso = falso('sp-falso',
  `process.stdout.write(${JSON.stringify(spReal)});process.exit(0);`);
const spBasura = falso('sp-basura',
  `process.stdout.write('no-json{');process.exit(1);`);
const spAusente = join(dirFalsos, 'inexistente-sp');

// Setea/restaura env alrededor de la promesa (tests secuenciales en el
// mismo proceso: node --test ejecuta cada archivo en su propio proceso)
async function conEnv(extra, fn) {
  const previas = Object.entries(extra);
  for (const [k, v] of previas) process.env[k] = v;
  try {
    return await fn();
  } finally {
    for (const [k, v] of previas) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('listarDispositivos: plataforma sin darwin → fail-closed, sin spawn', async () => {
  const r = await listarDispositivos({ plataforma: 'linux' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.data,
    { error: 'devices_unavailable', causa: 'plataforma_no_soportada' });
});

test('listarDispositivos: happy path con fuentes falsas reales', async () => {
  await conEnv({ GLOSOMATA_FFMPEG: ffmpegFalso,
    GLOSOMATA_SYSTEM_PROFILER: spFalso }, async () => {
    const r = await listarDispositivos({ plataforma: 'darwin' });
    assert.equal(r.code, 0, JSON.stringify(r.data));
    const { devices, platform, captured_at, limits } = r.data;
    assert.equal(platform, 'darwin');
    assert.ok(!Number.isNaN(Date.parse(captured_at)));
    assert.deepEqual(limits, { id_estable: false, seleccion_salida: false });
    assert.equal(r.data.degraded, undefined);
    // 3 entradas ffmpeg + 1 entrada system + 1 salida system = 5
    assert.equal(devices.length, 5);
    const ff = devices.filter((d) => d.source === 'ffmpeg');
    assert.deepEqual(ff.map((d) => [d.kind, d.id, d.name]), [
      ['input', '0', 'Jump Desktop Audio'],
      ['input', '1', 'Micrófono del MacBook Air'],
      ['input', '2', 'Jump Desktop Microphone'],
    ]);
    // is_default_glosomata: sólo el id '0' (literales del fixture)
    assert.deepEqual(
      ff.filter((d) => d.is_default_glosomata).map((d) => d.id), ['0']);
    // match por nombre del default de ENTRADA del SO: sólo el
    // 'Micrófono del MacBook Air' del fixture queda marcado
    assert.deepEqual(
      ff.filter((d) => d.is_default_so === true).map((d) => d.name),
      ['Micrófono del MacBook Air']);
    // defaults del SO como entradas `system` aparte (literales)
    const sysIn = devices.filter(
      (d) => d.source === 'system' && d.kind === 'input');
    assert.deepEqual(sysIn.map((d) => d.name),
      ['Micrófono del MacBook Air']);
    assert.ok(sysIn.every((d) => d.id === null && d.is_default_so === true));
    const sysOut = devices.filter(
      (d) => d.source === 'system' && d.kind === 'output');
    assert.deepEqual(sysOut.map((d) => d.name),
      ['Altavoces del MacBook Air']);
    assert.equal(sysOut[0].is_default_so, true);
  });
});

test('listarDispositivos: ffmpeg cae pero system lista → exit 0 degraded', async () => {
  for (const [nombre, falsoFf] of [['basura', ffmpegBasura],
    ['ausente', ffmpegAusente], ['timeout', ffmpegDormilon]]) {
    await conEnv({ GLOSOMATA_FFMPEG: falsoFf,
      GLOSOMATA_SYSTEM_PROFILER: spFalso }, async () => {
      const r = await listarDispositivos(
        { plataforma: 'darwin', timeoutMs: 300 });
      assert.equal(r.code, 0, `${nombre}: ${JSON.stringify(r.data)}`);
      assert.deepEqual(r.data.degraded, ['ffmpeg'], nombre);
      assert.equal(r.data.devices.some((d) => d.source === 'ffmpeg'), false,
        nombre);
      assert.ok(r.data.devices.some((d) => d.source === 'system'), nombre);
    });
  }
});

test('listarDispositivos: system cae pero ffmpeg lista → exit 0 degraded', async () => {
  await conEnv({ GLOSOMATA_FFMPEG: ffmpegFalso,
    GLOSOMATA_SYSTEM_PROFILER: spBasura }, async () => {
    const r = await listarDispositivos({ plataforma: 'darwin' });
    assert.equal(r.code, 0, JSON.stringify(r.data));
    assert.deepEqual(r.data.degraded, ['system_profiler']);
    // sin flags del SO no hay marcaje ni entradas `system`
    assert.ok(r.data.devices.every((d) => d.source === 'ffmpeg'));
    assert.ok(r.data.devices.every((d) => d.is_default_so === undefined));
  });
});

test('listarDispositivos: fallo total — precedencia de causas', async () => {
  await conEnv({ GLOSOMATA_FFMPEG: ffmpegBasura,
    GLOSOMATA_SYSTEM_PROFILER: spAusente }, async () => {
    const r = await listarDispositivos({ plataforma: 'darwin' });
    assert.equal(r.code, 1);
    assert.deepEqual(r.data, { error: 'devices_unavailable',
      causa: 'listado_ilegible' });
  });
  await conEnv({ GLOSOMATA_FFMPEG: ffmpegAusente,
    GLOSOMATA_SYSTEM_PROFILER: spBasura }, async () => {
    const r = await listarDispositivos({ plataforma: 'darwin' });
    assert.equal(r.code, 1);
    assert.deepEqual(r.data, { error: 'devices_unavailable',
      causa: 'ffmpeg_ausente' });
  });
});

// —— CLI: superficie estricta, JSON por stdout

function cliDevices(args, env = {}) {
  return spawnSync('node', [CLI, 'devices', ...args], {
    encoding: 'utf8', cwd: RAIZ,
    env: { ...process.env, ...env },
  });
}

test('CLI: devices — cualquier flag extra → exit 2 usage', () => {
  for (const args of [['--todo'], ['extra'], ['--device', '0']]) {
    const r = cliDevices(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage/);
    assert.equal(r.stdout, '');
  }
});

test('CLI: devices — happy path hermético en darwin', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('el CLI usa process.platform real: en linux responde fail-closed');
    return;
  }
  const r = cliDevices([], { GLOSOMATA_FFMPEG: ffmpegFalso,
    GLOSOMATA_SYSTEM_PROFILER: spFalso });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const out = JSON.parse(r.stdout);
  assert.equal(out.platform, 'darwin');
  assert.deepEqual(out.limits, { id_estable: false, seleccion_salida: false });
  assert.equal(out.degraded, undefined);
  assert.equal(out.devices.length, 5);
  assert.deepEqual(out.devices.filter((d) => d.source === 'system')
    .map((d) => d.name).sort(),
    ['Altavoces del MacBook Air', 'Micrófono del MacBook Air']);
  assert.ok(!r.stdout.includes(dirFalsos), 'sin rutas del filesystem');
});

test('CLI: devices — listado_ilegible total → exit 1, stdout vacío', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('el CLI usa process.platform real: en linux responde fail-closed');
    return;
  }
  const r = cliDevices([], { GLOSOMATA_FFMPEG: ffmpegBasura,
    GLOSOMATA_SYSTEM_PROFILER: spBasura });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /devices_unavailable/);
  assert.match(r.stderr, /listado_ilegible/);
  assert.equal(r.stdout, '');
});

test('CLI: devices — plataforma real sin darwin → exit 1 fail-closed', (t) => {
  if (process.platform === 'darwin') {
    t.skip('sólo observable en hosts no-darwin (CI linux)');
    return;
  }
  const r = cliDevices([], { GLOSOMATA_FFMPEG: ffmpegFalso,
    GLOSOMATA_SYSTEM_PROFILER: spFalso });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /devices_unavailable/);
  assert.match(r.stderr, /plataforma_no_soportada/);
  assert.equal(r.stdout, '');
});
