import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonizar,
  validarPlantilla,
  validarTurno,
  regexSegura,
} from '../src/plantillas.mjs';

test('canonizar: NFC + strip inaudibles + límite', () => {
  assert.equal(canonizar('cafe\u0301'), 'café'); // NFC compone
  assert.equal(canonizar('a\u200Bb\uFEFFc'), 'abc'); // zero-width/BOM fuera
  assert.equal(canonizar('x'.repeat(2000)).length, 2000);
  assert.throws(() => canonizar('x'.repeat(2001)), /text_too_long/);
});

test('validarPlantilla: esquema cerrado, rechaza lo no declarado', () => {
  const ok = { id: 't-1', kind: 'structured', proposed_by: 'agent',
    turns: [{ expectation: 'exact', pattern: 'si|no' }] };
  assert.equal(validarPlantilla(ok), true);
  assert.throws(() => validarPlantilla({ ...ok, kind: 'raro' }), /template_invalid/);
  assert.throws(() => validarPlantilla(null), /template_invalid/);
  assert.throws(() => validarPlantilla({ ...ok, id: '../escape' }), /template_invalid/);
  // campo extra: schema cerrado v1 lo rechaza (ADR ronda-2, contrato cerrado)
  assert.throws(() => validarPlantilla({ ...ok, extra: 1 }), /template_invalid/);
});

test('validarPlantilla: intent-free excluida de v1 → not_supported', () => {
  const t = { id: 't-2', kind: 'structured', proposed_by: 'agent',
    turns: [{ expectation: 'intent-free' }] };
  assert.throws(() => validarPlantilla(t), (e) => e.code === 'not_supported');
});

test('regexSegura: dialecto v1 rechaza constructos peligrosos', () => {
  assert.throws(() => regexSegura('(a+)+b'), /template_invalid/); // ReDoS clásico
  assert.throws(() => regexSegura('a{2,}'), /template_invalid/);
  assert.throws(() => regexSegura('\\1'), /template_invalid/);
  assert.throws(() => regexSegura('(a|aa)+$'), /template_invalid/); // alternancia ambigua
  assert.doesNotThrow(() => regexSegura('si|no'));
  assert.doesNotThrow(() => regexSegura('[a-z ]{1,20}'));
  // rendimiento: patrón benigno máximo contra texto máximo, lineal
  const re = regexSegura('[a-z ]{1,2000}');
  const t0 = Date.now();
  re.test('a'.repeat(2000));
  const dt = Date.now() - t0;
  assert.ok(dt < 100, `match tardó ${dt}ms`);
});

test('regexSegura: ")" en clase de caracteres no ciega el escáner', () => {
  // bypass reproducido ronda 3: la ')' dentro de [)x] confundía el conteo
  // de profundidad y el grupo cuantificado quedaba sin inspección
  assert.throws(() => regexSegura('([)x]|(xx))*'), /template_invalid/);
  assert.throws(() => regexSegura('([)x]|(xx))+'), /template_invalid/);
});

test('regexSegura: paréntesis escapados no rompen el pareo de grupos', () => {
  assert.throws(() => regexSegura('(\\)|a|aa)*'), /template_invalid/);
  // escapes literales fuera de grupos cuantificados siguen siendo válidos
  assert.doesNotThrow(() => regexSegura('dime \\(sí\\)'));
  assert.doesNotThrow(() => regexSegura('\\(ok\\)'));
});

test('regexSegura: desbalanceados → fail-closed', () => {
  assert.throws(() => regexSegura('(abc'), /template_invalid/);
  assert.throws(() => regexSegura('abc)'), /template_invalid/);
  assert.throws(() => regexSegura('[a-z'), /template_invalid/);
});

test('regexSegura: cadenas de cuantificadores sin grupo → fail-closed', () => {
  // ronda adversarial 4: 'a*a*a*b' aceptado → 3s con 40 chars de texto
  assert.throws(() => regexSegura('a*a*a*b'), /template_invalid/);
  assert.throws(() => regexSegura('.*.*b'), /template_invalid/);
  assert.throws(() => regexSegura('a?a?a?b'), /template_invalid/);
  assert.throws(() => regexSegura('a{0,9}a{0,9}b'), /template_invalid/);
});

test('regexSegura: un cuantificador por rama sigue siendo válido', () => {
  assert.doesNotThrow(() => regexSegura('a*|b*'));
  assert.doesNotThrow(() => regexSegura('(ab)*'));
  assert.doesNotThrow(() => regexSegura('[a-z ]{1,40}'));
});

test('regexSegura: interior tokenizado no rechaza clases ni escapes', () => {
  assert.doesNotThrow(() => regexSegura('([?!])*'));
  assert.doesNotThrow(() => regexSegura('(\\?)*'));
  assert.doesNotThrow(() => regexSegura('([a|b])*'));
  assert.doesNotThrow(() => regexSegura('(?:a)*'));
  // el salto de '(?:' exige '(' previo: un '?' real no se contrabandea
  assert.throws(() => regexSegura('(a?:)*'), /template_invalid/);
});

test('validarTurno: función pura, plantilla confirmar', () => {
  const confirmar = { id: 'confirmar', kind: 'structured', proposed_by: 'builtin',
    turns: [{ expectation: 'exact', pattern: 'sí|no|si' }] };
  assert.deepEqual(validarTurno(confirmar, 0, 'sí'),
    { result: 'ok', next_turn: 1 });
  assert.deepEqual(validarTurno(confirmar, 0, 'NO'),
    { result: 'ok', next_turn: 1 }); // case-insensitive
  assert.deepEqual(validarTurno(confirmar, 0, 'tal vez'),
    { result: 'fail', expected: 'sí|no|si', next_turn: 0 });
});

test('validarTurno: modo libre = no-op declarada, avanza turno', () => {
  const libre = { id: 'libre', kind: 'free', proposed_by: 'builtin', turns: [] };
  assert.deepEqual(validarTurno(libre, 3, 'lo que sea'),
    { result: 'ok', next_turn: 4 });
});

test('validarTurno: turno inválido → session_invalid', () => {
  const libre = { id: 'libre', kind: 'free', proposed_by: 'builtin', turns: [] };
  assert.throws(() => validarTurno(libre, -1, 'x'), (e) => e.code === 'session_invalid');
  assert.throws(() => validarTurno(libre, 1.5, 'x'), (e) => e.code === 'session_invalid');
});
