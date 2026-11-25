// Enmienda v1.7 (2026-11-24): hints de rango --min-speakers /
// --max-speakers de `diarize` con MOTOR FALSO (hermético: registra
// argv y emite conductas del contrato §4). La operación completa sin
// hints vive en tests/diarize-op.test.mjs — suite nueva por el
// límite de 800 líneas del gate (precedente diar/stt-turbo).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync,
  readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'src/cli.mjs';
const CWD = new URL('..', import.meta.url).pathname;

// —— falso python (hermético): registra argv/env y emite la
// conducta «ok» del contrato §4 — DOS hablantes (voz_a/voz_b)
// siempre, para asertar el passthrough: Node NO acota la salida
// por los hints, el conteo es el del motor — y «ok-emb» con
// huellas, para la combinación hints + --embeddings ——

const dirFalso = mkdtempSync(join(tmpdir(), 'glosomata-diar-hints-'));
const FALSO_PY = join(dirFalso, 'fake-diar-python');
writeFileSync(FALSO_PY, `#!/usr/bin/env node
const fs = require('node:fs');
const modo = process.env.GLOSOMATA_DIAR_FAKE_MODE ?? 'ok';
const log = process.env.GLOSOMATA_DIAR_FAKE_LOG;
if (log) fs.writeFileSync(log, JSON.stringify({
  argv: process.argv.slice(2),
  PYANNOTE_METRICS_ENABLED: process.env.PYANNOTE_METRICS_ENABLED,
  HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE,
}));
const emitir = (o) => process.stdout.write(JSON.stringify(
  { device: 'cpu', ...o }), () => process.exit(0));
const modos = {
  ok: () => emitir({ turns: [
    { speaker: 'voz_b', start_s: 1.5, end_s: 2.5 },
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
    { speaker: 'voz_b', start_s: 3, end_s: 4 },
  ] }),
  'ok-emb': () => emitir({ turns: [
    { speaker: 'voz_b', start_s: 1.5, end_s: 2.5 },
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
  ],
  embeddings: {
    voz_a: [0.11, 0.22, 0.33, 0.44],
    voz_b: [-0.11, -0.22, -0.33, -0.44],
  } }),
};
(modos[modo] ?? (() => process.exit(1)))();
`);
chmodSync(FALSO_PY, 0o755);

// stubs estructurales (el probe exige existencia; el falso no los lee)
const fixScript = join(dirFalso, 'stub-script.py');
const fixPipeline = join(dirFalso, 'stub-pipeline');
writeFileSync(fixScript, '');
mkdirSync(fixPipeline);
writeFileSync(join(fixPipeline, 'config.yaml'), '');

const DIAR_FALSO = { python: FALSO_PY, script: fixScript,
  pipeline: fixPipeline };

// base rota EN CUALQUIER plataforma (kokoro → python_ausente):
// diarize no la sufre (no toma canal), sólo necesita engines.diar
const CONFIG_TTS_ROTO = {
  engines: {
    tts: [{ id: 'kokoro-x', adapter: 'kokoro', selected: true,
      python: '/no/existe/python', model: '/no/existe/model',
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 300 } }],
    stt: {},
    diar: DIAR_FALSO,
  },
};

function configTemporal(contenido) {
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-diar-hints-cfg-'));
  const ruta = join(dir, 'glosomata.json');
  writeFileSync(ruta, JSON.stringify(contenido));
  return ruta;
}

const AUDIO_X = join(dirFalso, 'reunion.wav');
writeFileSync(AUDIO_X, 'audio-falso');

function salidaDiarize(argvCli, rutaCfg, extra = {}) {
  const r = spawnSync('node', [CLI, ...argvCli], {
    encoding: 'utf8', cwd: CWD,
    env: { ...process.env, GLOSOMATA_CONFIG: rutaCfg, ...extra },
  });
  return { code: r.status, out: String(r.stdout ?? ''),
    err: String(r.stderr ?? '') };
}

const CFG = () => configTemporal(CONFIG_TTS_ROTO);

// argv del script según el registro del falso
function argvRegistrado(args, rutaLog, extra = {}) {
  const r = salidaDiarize(['diarize', ...args], CFG(),
    { GLOSOMATA_DIAR_FAKE_LOG: rutaLog, ...extra });
  assert.equal(r.code, 0, r.err);
  return JSON.parse(readFileSync(rutaLog, 'utf8')).argv;
}

// —— argv registrado (contrato §4: 8º y 9º tokens, centinela '0') ——

test('hints: sin hints → tokens 8º y 9º en centinela "0"', () => {
  const rutaLog = join(dirFalso, 'log-sin.json');
  const argv = argvRegistrado(['--file', AUDIO_X], rutaLog);
  assert.deepEqual(argv,
    [fixScript, fixPipeline, AUDIO_X, '14400', '0', 'cpu', '0', '0']);
});

test('hints: min y max viajan como 8º y 9º token', () => {
  const rutaLog = join(dirFalso, 'log-mm.json');
  const argv = argvRegistrado(
    ['--file', AUDIO_X, '--min-speakers', '2', '--max-speakers', '4'],
    rutaLog);
  assert.equal(argv[6], '2');
  assert.equal(argv[7], '4');
  // el resto del argv no cambia por los hints
  assert.deepEqual(argv.slice(0, 6),
    [fixScript, fixPipeline, AUDIO_X, '14400', '0', 'cpu']);
});

test('hints: sólo min → max en centinela; sólo max → min en centinela', () => {
  const logMin = join(dirFalso, 'log-min.json');
  const argvMin = argvRegistrado(
    ['--file', AUDIO_X, '--min-speakers', '3'], logMin);
  assert.equal(argvMin[6], '3');
  assert.equal(argvMin[7], '0');

  const logMax = join(dirFalso, 'log-max.json');
  const argvMax = argvRegistrado(
    ['--file', AUDIO_X, '--max-speakers', '5'], logMax);
  assert.equal(argvMax[6], '0');
  assert.equal(argvMax[7], '5');
});

test('hints: cualquier orden relativo admitido registra lo mismo', () => {
  const casos = [
    ['--min-speakers', '2', '--file', AUDIO_X],
    ['--file', AUDIO_X, '--embeddings', '--min-speakers', '2',
      '--max-speakers', '4'],
    ['--embeddings', '--max-speakers', '4', '--min-speakers', '2',
      '--file', AUDIO_X],
    ['--max-speakers', '4', '--file', AUDIO_X, '--min-speakers', '2'],
    ['--file', AUDIO_X, '--max-speakers', '4', '--embeddings'],
  ];
  for (const args of casos) {
    const rutaLog = join(dirFalso,
      `log-orden-${casos.indexOf(args)}.json`);
    // ok-emb emite turns+embeddings: sirve con y sin el flag
    const argv = argvRegistrado(args, rutaLog,
      { GLOSOMATA_DIAR_FAKE_MODE: 'ok-emb' });
    const iMin = args.indexOf('--min-speakers');
    const iMax = args.indexOf('--max-speakers');
    assert.deepEqual(argv.slice(6),
      [iMin === -1 ? '0' : args[iMin + 1],
        iMax === -1 ? '0' : args[iMax + 1]],
      JSON.stringify(args));
    // el modo de huellas sigue viajando como 6º token
    assert.equal(argv[4], args.includes('--embeddings') ? '1' : '0',
      JSON.stringify(args));
  }
});

test('hints: enteros de varios dígitos viajan tal cual', () => {
  const rutaLog = join(dirFalso, 'log-grande.json');
  const argv = argvRegistrado(
    ['--file', AUDIO_X, '--min-speakers', '10', '--max-speakers', '24'],
    rutaLog);
  assert.equal(argv[6], '10');
  assert.equal(argv[7], '24');
});

// —— usage (exit 2, código existente de la taxonomía) ——

test('hints: valores no enteros ≥ 1 → usage', () => {
  for (const malo of ['1.5', 'x', '1e3', '', '-1', '-3', '+2', '01',
    '2.0', '0x2', '1 ', '--embeddings']) {
    const r = salidaDiarize(
      ['diarize', '--file', AUDIO_X, '--min-speakers', malo], CFG());
    assert.equal(r.code, 2, `--min-speakers ${JSON.stringify(malo)}`);
    assert.match(r.err, /usage/);
    const r2 = salidaDiarize(
      ['diarize', '--file', AUDIO_X, '--max-speakers', malo], CFG());
    assert.equal(r2.code, 2, `--max-speakers ${JSON.stringify(malo)}`);
    assert.match(r2.err, /usage/);
  }
});

test('hints: 0 explícito no es válido (el centinela vive en el argv del script, no en la CLI)', () => {
  const r = salidaDiarize(
    ['diarize', '--file', AUDIO_X, '--min-speakers', '0'], CFG());
  assert.equal(r.code, 2);
  const r2 = salidaDiarize(
    ['diarize', '--file', AUDIO_X, '--max-speakers', '0'], CFG());
  assert.equal(r2.code, 2);
});

test('hints: min > max cuando ambos → usage (incluido invertido en argv)', () => {
  for (const args of [
    ['--file', AUDIO_X, '--min-speakers', '3', '--max-speakers', '2'],
    ['--max-speakers', '2', '--min-speakers', '3', '--file', AUDIO_X],
    ['--min-speakers', '10', '--file', AUDIO_X, '--max-speakers', '9'],
  ]) {
    const r = salidaDiarize(['diarize', ...args], CFG());
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage/);
  }
  // min == max ES válido (rango degenerado: pyannote lo fuerza
  // como num_speakers interno)
  const rutaLog = join(dirFalso, 'log-igual.json');
  const argv = argvRegistrado(
    ['--file', AUDIO_X, '--min-speakers', '2', '--max-speakers', '2'],
    rutaLog);
  assert.deepEqual(argv.slice(6), ['2', '2']);
});

test('hints: duplicados → usage (uno por flag)', () => {
  for (const args of [
    ['--file', AUDIO_X, '--min-speakers', '2', '--min-speakers', '3'],
    ['--file', AUDIO_X, '--max-speakers', '2', '--max-speakers', '2'],
    ['--min-speakers', '2', '--min-speakers', '2', '--file', AUDIO_X],
  ]) {
    const r = salidaDiarize(['diarize', ...args], CFG());
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage/);
  }
});

test('hints: formas inválidas → usage', () => {
  for (const args of [
    ['--min-speakers'],                       // sin valor
    ['--file', AUDIO_X, '--min-speakers'],    // colgando al final
    ['--min-speakers', '--file', AUDIO_X],    // flag en posición de valor
    ['--file', AUDIO_X, '--min-speaker', '2'], // singular
    ['--file', AUDIO_X, '--min_speakers', '2'], // guion bajo
    ['--file', AUDIO_X, 'min-speakers', '2'],   // sin --
    ['--file', AUDIO_X, '--min-speakers', '2', 'extra'],
    ['--min-speakers', '2'],                  // sin --file
  ]) {
    const r = salidaDiarize(['diarize', ...args], CFG());
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage/, JSON.stringify(args));
  }
});

// —— passthrough: Node NO acota la salida por los hints ——

test('hints: num_speakers de la respuesta es el del motor, sin acotar', () => {
  // el falso SIEMPRE reporta 2 hablantes: con hints contradictorios
  // la respuesta NO se reescribe — la acotación vive en el motor
  // (contrato §9.7), Node sólo transporta los tokens
  const r = salidaDiarize(
    ['diarize', '--file', AUDIO_X, '--max-speakers', '1'], CFG());
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).num_speakers, 2);

  const r2 = salidaDiarize(
    ['diarize', '--file', AUDIO_X, '--min-speakers', '5'], CFG());
  assert.equal(r2.code, 0);
  assert.equal(JSON.parse(r2.out).num_speakers, 2);
});

test('hints: la forma de la respuesta no cambia por los hints', () => {
  const r = salidaDiarize(
    ['diarize', '--file', AUDIO_X, '--min-speakers', '2',
      '--max-speakers', '4'], CFG());
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  // mismas claves de siempre: ni eco de los hints ni campos nuevos
  assert.deepEqual(Object.keys(d),
    ['turns', 'num_speakers', 'mode', 'device', 'duration_ms']);
  assert.equal(d.mode, 'exclusive');
  assert.equal(d.num_speakers, 2);
});

// —— huellas + hints combinados ——

test('hints + --embeddings: huellas por etiqueta canónica y argv con hints', () => {
  const rutaLog = join(dirFalso, 'log-emb-hints.json');
  const r = salidaDiarize(
    ['diarize', '--file', AUDIO_X, '--embeddings',
      '--min-speakers', '2', '--max-speakers', '2'],
    CFG(), { GLOSOMATA_DIAR_FAKE_LOG: rutaLog,
      GLOSOMATA_DIAR_FAKE_MODE: 'ok-emb' });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.deepEqual(Object.keys(d.speakers), ['SPEAKER_00', 'SPEAKER_01']);
  assert.deepEqual(d.speakers.SPEAKER_00,
    { embedding: [0.11, 0.22, 0.33, 0.44], dim: 4 });
  assert.equal(d.embedding_model,
    'speaker-diarization-community-1#embedding');
  const argv = JSON.parse(readFileSync(rutaLog, 'utf8')).argv;
  assert.deepEqual(argv.slice(4), ['1', 'cpu', '2', '2']);
  // garantía biométrica (política de logs): sin huella en stderr
  assert.ok(!r.err.includes('0.11') && !r.err.includes('0.44'),
    'huella en stderr');
});

// —— sin hints, conducta intacta (regresión de la enmienda) ——

test('hints: sin hints la conducta de siempre no cambia (regresión)', () => {
  const r = salidaDiarize(
    ['diarize', '--embeddings', '--file', AUDIO_X], CFG(),
    { GLOSOMATA_DIAR_FAKE_MODE: 'ok-emb' });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.ok(d.speakers);
  assert.equal(d.num_speakers, 2);
});


after(() => rmSync(dirFalso, { recursive: true, force: true }));
