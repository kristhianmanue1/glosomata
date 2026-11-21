// D1 de diarización (ADR-012): schema engines.diar + constraints,
// probe estructural diagnosticoDiar, wiring de doctor y de
// config validate/set. Expectaciones leídas del contrato
// docs/specs/contrato-diarizacion-v1.md (§3.1/§6/§7), no del código.

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
