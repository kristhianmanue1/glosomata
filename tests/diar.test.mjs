// D1 de diarización (ADR-012): schema engines.diar + constraints,
// probe estructural diagnosticoDiar y el enum de device. La
// operación CLI de `diarize` (motor falso), doctor y config
// validate/set viven en tests/diarize-op.test.mjs. Expectaciones
// leídas del contrato docs/specs/contrato-diarizacion-v1.md
// (§3.1/§6/§7), no del código.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync,
  readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validar } from '../src/schema.mjs';
import { diagnosticoDiar } from '../src/diar.mjs';

const CLI = 'src/cli.mjs';
const CWD = new URL('..', import.meta.url).pathname;

const schema = JSON.parse(await readFile(
  new URL('../docs/schemas/glosomata-config-v1.schema.json', import.meta.url),
  'utf8'));

// —— fixtures de filesystem: python/script/pipeline falsos (hermético:
// jamás se ejecuta nada; el probe es estructural) ——

const dirFix = mkdtempSync(join(tmpdir(), 'glosomata-diar-'));
const fixPython = join(dirFix, 'python');
const fixScript = join(dirFix, 'diarize_pyannote.py');
const fixPipeline = join(dirFix, 'pipeline');
writeFileSync(fixPython, '');
writeFileSync(fixScript, '');
mkdirSync(fixPipeline);
writeFileSync(join(fixPipeline, 'config.yaml'), '');

const DIAR_SANO = { python: fixPython, script: fixScript,
  pipeline: fixPipeline };

// base rota EN CUALQUIER plataforma (kokoro → python_ausente): sólo
// para que el schema tenga una matriz completa donde insertar diar
const CONFIG_TTS_ROTO = {
  engines: {
    tts: [{ id: 'kokoro-x', adapter: 'kokoro', selected: true,
      python: '/no/existe/python', model: '/no/existe/model',
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 300 } }],
    stt: {},
  },
};

const configSchema = (diar, constraints) => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  if (diar !== undefined) cfg.engines.diar = diar;
  if (constraints !== undefined) cfg.constraints = constraints;
  return cfg;
};

test('schema: engines.diar completo valida', () => {
  const errores = validar(configSchema(DIAR_SANO), schema);
  assert.deepEqual(errores, []);
});

test('schema: diar sin pipeline → rechazo (las TRES rutas requeridas)', () => {
  const { pipeline, ...sinPipeline } = DIAR_SANO;
  assert.notEqual(
    validar(configSchema(sinPipeline), schema).length, 0);
});

test('schema: clave extra en diar → rechazo (cerrado)', () => {
  const conExtra = { ...DIAR_SANO, num_speakers: 2 };
  assert.notEqual(validar(configSchema(conExtra), schema).length, 0);
});

test('schema: constraints diar en rango validan; fuera, rechazo', () => {
  assert.deepEqual(
    validar(configSchema(undefined,
      { diar_max_duration_s: 14400, diar_max_wall_s: 7200 }), schema),
    []);
  for (const mala of [
    { diar_max_duration_s: 30 }, // bajo el mínimo 60
    { diar_max_duration_s: 90000 }, // sobre el tope 86400
    { diar_max_wall_s: 10 },
    { diar_max_wall_s: 100000 },
    { diar_max_duration_s: 'largo' }, // tipo
  ]) {
    assert.notEqual(
      validar(configSchema(undefined, mala), schema).length, 0,
      JSON.stringify(mala));
  }
});

// —— diagnosticoDiar: unidad pura (sin subprocess) ——

test('diagnosticoDiar: ausente → null (no declarado no es defecto)', async () => {
  assert.equal(await diagnosticoDiar(CONFIG_TTS_ROTO), null);
  assert.equal(await diagnosticoDiar({ engines: {} }), null);
});

test('diagnosticoDiar: forma basura → probe_fallido (fail-closed)', async () => {
  assert.deepEqual(await diagnosticoDiar({ engines: { diar: 42 } }),
    { ok: false, causa: 'probe_fallido' });
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: { python: '/x' } } }),
    { ok: false, causa: 'probe_fallido' });
});

test('diagnosticoDiar: orden de causas python → script → pesos', async () => {
  const con = (over) => ({ engines: { diar: { ...DIAR_SANO, ...over } } });
  assert.deepEqual(
    await diagnosticoDiar(con({ python: '/no/existe/python' })),
    { ok: false, causa: 'python_ausente' });
  assert.deepEqual(
    await diagnosticoDiar(con({ script: '/no/existe/s.py' })),
    { ok: false, causa: 'script_ausente' });
  assert.deepEqual(
    await diagnosticoDiar(con({ pipeline: '/no/existe/pipeline' })),
    { ok: false, causa: 'pesos_ausentes' });
});

test('diagnosticoDiar: pipeline archivo (no dir) o sin config.yaml → pesos_ausentes', async () => {
  const archivo = join(dirFix, 'no-dir.yaml');
  writeFileSync(archivo, '');
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: { ...DIAR_SANO,
      pipeline: archivo } } }),
    { ok: false, causa: 'pesos_ausentes' });
  const sinCfg = join(dirFix, 'pipeline-vacio');
  mkdirSync(sinCfg);
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: { ...DIAR_SANO,
      pipeline: sinCfg } } }),
    { ok: false, causa: 'pesos_ausentes' });
});

test('diagnosticoDiar: fixture sano → ok', async () => {
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: DIAR_SANO } }),
    { ok: true });
});

// —— doctor: sección opcional con gate (contrato §7) ——

test('schema: engines.diar.device enum cpu|cuda|mps; fuera → rechazo', () => {
  const cfg = (dev) => ({ engines: {
    tts: [{ id: 'say', adapter: 'say', selected: true,
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 200 } }],
    stt: {}, diar: { ...DIAR_SANO, device: dev } } });
  assert.deepEqual(validar(cfg('mps'), schema), []);
  assert.deepEqual(validar(cfg('cpu'), schema), []);
  assert.notEqual(validar(cfg('tpu'), schema).length, 0);
});

after(() => rmSync(dirFix, { recursive: true, force: true }));
