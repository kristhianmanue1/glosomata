// P1.1: config list / config get — lectura cruda de la matriz por
// CLI, con GLOSOMATA_CONFIG aislado. Sin mocks: el contrato es
// observable por proceso.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'src/cli.mjs';
const CWD = new URL('..', import.meta.url).pathname;

const CONFIG_VALIDA = {
  engines: {
    tts: [{ id: 'say', adapter: 'say', selected: true,
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 200 } }],
    stt: {},
  },
  constraints: { session_ttl_min: 15 },
};

function configAislada(contenido) {
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-cfg-'));
  const ruta = join(dir, 'glosomata.json');
  writeFileSync(ruta, typeof contenido === 'string'
    ? contenido : JSON.stringify(contenido));
  return ruta;
}

function cli(args, rutaCfg) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    cwd: CWD,
    env: { ...process.env, GLOSOMATA_CONFIG: rutaCfg },
  });
}

test('config list: entrega el JSON crudo de disco', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const out = JSON.parse(cli(['config', 'list'], ruta));
  assert.deepEqual(out, CONFIG_VALIDA);
});

test('config list: crudo de verdad — sin campos derivados de probes', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const out = JSON.parse(cli(['config', 'list'], ruta));
  assert.equal('available' in out.engines.tts[0], false);
  assert.equal('causa' in out.engines.tts[0], false);
});

test('config list: config ilegible → config_unreadable', () => {
  const ruta = configAislada('{ esto no es json');
  assert.throws(() => cli(['config', 'list'], ruta),
    (e) => e.status === 1 && /config_unreadable/.test(e.stderr));
});

test('config get engines: subárbol completo', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const out = JSON.parse(cli(['config', 'get', 'engines'], ruta));
  assert.deepEqual(out, CONFIG_VALIDA.engines);
});

test('config get constraints: subárbol y ausencia declarada (null)', () => {
  const sinConstraints = { engines: CONFIG_VALIDA.engines };
  const ruta = configAislada(sinConstraints);
  const out = JSON.parse(cli(['config', 'get', 'constraints'], ruta));
  assert.equal(out, null);
});

test('config get: sección inventada o traversal → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  for (const mala of ['motores', 'engines.tts', 'engines.tts.0.id']) {
    assert.throws(() => cli(['config', 'get', mala], ruta),
      (e) => e.status === 2 && /usage/.test(e.stderr), mala);
  }
});

test('config get: sin sección → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config', 'get'], ruta),
    (e) => e.status === 2);
});

test('config: sin subcomando o desconocido → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config'], ruta), (e) => e.status === 2);
  assert.throws(() => cli(['config', 'edit'], ruta), (e) => e.status === 2);
});

test('config list: argumentos extra → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config', 'list', '--todo'], ruta),
    (e) => e.status === 2);
});
