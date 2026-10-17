import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const CLI = 'src/cli.mjs';

function cli(args) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
}

test('CLI: ayuda sin comandos', () => {
  const out = cli([]);
  assert.match(out, /uso: glosomata/);
});

test('CLI: comando desconocido → exit 2', () => {
  assert.throws(() => cli(['nada']), (e) => e.status === 2);
});

test('CLI: templates --list entrega catálogo sin turns', () => {
  const out = JSON.parse(cli(['templates', '--list']));
  assert.ok(Array.isArray(out));
  assert.ok(out.some((t) => t.id === 'confirmar'));
  assert.ok(out.every((t) => t.turns === undefined));
});

test('CLI: templates --show con id válido', () => {
  const t = JSON.parse(cli(['templates', '--show', 'confirmar']));
  assert.equal(t.kind, 'structured');
});

test('CLI: templates --show traversal → template_invalid', () => {
  assert.throws(() => cli(['templates', '--show', '../etc/passwd']),
    (e) => /template_invalid/.test(e.stderr));
});

test('CLI: session new sin plantilla emite sesión v1', () => {
  const ses = JSON.parse(cli(['session', 'new']));
  assert.equal(ses.schema, 'glosomata/sesion-v1');
});

test('CLI: session new --template confirmar incrusta plantilla', () => {
  const ses = JSON.parse(cli(['session', 'new', '--template', 'confirmar']));
  assert.equal(ses.template.id, 'confirmar');
});

test('CLI: session new sin template → validate ok (SPEC-2, C1.5)', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const ses = JSON.parse(cli(['session', 'new']));
  assert.equal(ses.template, null);
  const ruta = join(mkdtempSync(join(tmpdir(), 'glosomata-test-')), 's.json');
  writeFileSync(ruta, JSON.stringify(ses));
  assert.equal(execFileSyncStatus(['validate', '--session', ruta, '--text', 'lo que sea']), 0);
});

test('CLI: validate JSON null / sin schema → session_invalid, sin TypeError (C1.3)', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-test-'));
  const nula = join(dir, 'null.json');
  writeFileSync(nula, 'null');
  // null.json antes explotaba con TypeError crudo fuera de la taxonomía
  assert.throws(
    () => execFileSync('node', [CLI, 'validate', '--session', nula, '--text', 'x'], {
      cwd: new URL('..', import.meta.url).pathname,
    }),
    (e) => e.status === 1 && /session_invalid/.test(e.stderr)
      && !/TypeError/.test(e.stderr));
  const ses = JSON.parse(cli(['session', 'new', '--template', 'confirmar']));
  delete ses.schema;
  const sinSchema = join(dir, 'sin-schema.json');
  writeFileSync(sinSchema, JSON.stringify(ses));
  assert.throws(
    () => execFileSync('node', [CLI, 'validate', '--session', sinSchema, '--text', 'sí'], {
      cwd: new URL('..', import.meta.url).pathname,
    }),
    (e) => e.status === 1 && /session_invalid/.test(e.stderr));
});

test('CLI: session new con session_ttl_min malformado → config_unreadable (C1.3)', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const ruta = join(mkdtempSync(join(tmpdir(), 'glosomata-test-')), 'g.json');
  // string numérico: antes la coerción acuñaba sesiones muertas al nacer
  writeFileSync(ruta, JSON.stringify({
    engines: { tts: [], stt: {} },
    constraints: { session_ttl_min: '30' },
  }));
  assert.throws(
    () => execFileSync('node', [CLI, 'session', 'new'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, GLOSOMATA_CONFIG: ruta },
    }),
    (e) => e.status === 1 && /config_unreadable/.test(e.stderr));
});

test('CLI: validate ok exit 0 / fail exit 1', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-test-'));
  const ses = JSON.parse(cli(['session', 'new', '--template', 'confirmar']));
  const ruta = join(dir, 'ses.json');
  writeFileSync(ruta, JSON.stringify(ses));
  assert.equal(execFileSyncStatus(['validate', '--session', ruta, '--text', 'sí']), 0);
  assert.equal(execFileSyncStatus(['validate', '--session', ruta, '--text', 'nse']), 1);
});

function execFileSyncStatus(args) {
  try {
    execFileSync('node', [CLI, ...args], {
      cwd: new URL('..', import.meta.url).pathname,
    });
    return 0;
  } catch (e) {
    return e.status;
  }
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('CLI: version refleja package.json (fuente única, C0.1)', () => {
  const pkg = JSON.parse(
    require('node:fs').readFileSync(
      new URL('../package.json', import.meta.url), 'utf8'));
  const out = JSON.parse(cli(['version']));
  assert.equal(out.name, pkg.name);
  assert.equal(out.version, pkg.version);
});
