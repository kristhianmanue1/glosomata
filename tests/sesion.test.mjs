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

test('sesión: ttl_min malformado → expirada, jamás fail-open (C1.3)', () => {
  const hace400Dias = new Date(Date.now() - 400 * 86_400_000).toISOString();
  assert.equal(expirada({ created_at: hace400Dias, ttl_min: 'para_siempre' }), true);
  assert.equal(expirada({ created_at: hace400Dias, ttl_min: NaN }), true);
  assert.equal(expirada({ created_at: hace400Dias, ttl_min: -5 }), true);
  // string numérico deja de pasar por coerción: fail-closed también
  assert.equal(expirada({ created_at: hace400Dias, ttl_min: '30' }), true);
  // ttl 0: expira al primer avance del reloj (fórmula literal del spec)
  assert.equal(expirada({ created_at: hace400Dias, ttl_min: 0 }), true);
  assert.equal(
    expirada({ created_at: new Date().toISOString(), ttl_min: 0 },
      Date.now() + 1), true);
});

test('sesión: formaValida — única definición de forma v1 (C1.3)', async () => {
  const { formaValida } = await import('../src/sesion.mjs');
  const ses = acunar(null);
  assert.equal(formaValida(ses), true);
  assert.equal(formaValida(null), false);
  assert.equal(formaValida([]), false);
  assert.equal(formaValida('x'), false);
  assert.equal(formaValida({ ...ses, schema: 'otra/cosa' }), false);
  assert.equal(formaValida({ ...ses, schema: 'undefined' }), false); // string literal
  assert.equal(formaValida({ turn: 0, template: null }), false); // sin schema
});
