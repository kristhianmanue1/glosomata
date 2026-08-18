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
