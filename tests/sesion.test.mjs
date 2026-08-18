import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expirada, acunar } from '../src/sesion.mjs';

test('sesión: acuña con uuid v4 canónico y turn 0', () => {
  const ses = acunar(null);
  assert.match(ses.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(ses.turn, 0);
  assert.equal(ses.template, null);
});

test('sesión: TTL expira con el tiempo', () => {
  const ses = acunar(null, 1);
  const ahora = Date.now();
  assert.equal(expirada(ses, ahora), false);
  assert.equal(expirada(ses, ahora + 61_000), true); // >1 min
});

test('sesión: created_at corrupto → expirada (fail-closed)', () => {
  assert.equal(expirada({ created_at: 'basura' }), true);
  assert.equal(expirada({}), true);
});
