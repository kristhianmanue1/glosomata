// P0.2: el schema formal de glosomata.json valida lo que existe y
// rechaza lo que no. Controles positivos Y negativos (un chequeo que
// no puede fallar no prueba nada), y vigilancia meta: el schema sólo
// usa las palabras clave que tests/helpers/schema.mjs implementa.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validar } from '../src/schema.mjs';

const schema = JSON.parse(await readFile(
  new URL('../docs/schemas/glosomata-config-v1.schema.json', import.meta.url),
  'utf8'));

const lee = async (ruta) => JSON.parse(await readFile(
  new URL(ruta, import.meta.url), 'utf8'));

// —— controles positivos ——

test('schema: glosomata.example.json valida', async () => {
  const errores = validar(await lee('../glosomata.example.json'), schema);
  assert.deepEqual(errores, []);
});

test('schema: la config real del operador valida (criterio P0.2)', async () => {
  // glosomata.json está versionado: el criterio corre también en CI.
  const errores = validar(await lee('../glosomata.json'), schema);
  assert.deepEqual(errores, []);
});

test('schema: config mínima (say sólo, sin constraints) valida', () => {
  const errores = validar({
    engines: {
      tts: [{ id: 'say', adapter: 'say', selected: true,
        kill_switch: { type: 'subprocess_kill', target: 'process_group',
          max_latency_ms: 200 } }],
      stt: {},
    },
  }, schema);
  assert.deepEqual(errores, []);
});

test('schema: TODAS las claves opcionales validan (el example pasa vacío)', () => {
  const errores = validar({
    engines: {
      tts: [
        { id: 'voz-say', adapter: 'say', selected: true, voice: 'alex',
          rate: 180,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 200 } },
        { id: 'voz-piper', adapter: 'piper', selected: false,
          bin: '/bin/piper', model: '/m/onnx', sample_rate: 22050,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 500 } },
        { id: 'voz-kokoro', adapter: 'kokoro', selected: false,
          python: '/bin/python', script: 'src/tts/synthesize_kokoro.py',
          model: '/m/kokoro', voice: 'em_alex', pitch_scale: 1.1,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 300 } },
      ],
      stt: { whisper_bin: '/bin/whisper-cli', whisper_model: '/m/ggml.bin' },
    },
    constraints: {
      validation_floor_ms: 50, confirmation_channels: 2,
      max_pattern_chars: 200, session_ttl_min: 15, max_text_chars: 2000,
      listen_default_timeout_s: 10,
    },
  }, schema);
  assert.deepEqual(errores, []);
});

test('schema: claves deprecated VALIDAN (son anotación, no rechazo)', () => {
  const errores = validar({
    engines: { tts: [{ id: 'say', adapter: 'say', selected: true,
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 200 } }], stt: {} },
    constraints: { validation_floor_ms: 50 },
  }, schema);
  assert.deepEqual(errores, []);
});

// —— controles negativos (falsabilidad) ——

const configValida = () => ({
  engines: { tts: [{ id: 'say', adapter: 'say', selected: true,
    kill_switch: { type: 'subprocess_kill', target: 'process_group',
      max_latency_ms: 200 } }], stt: {} },
});

test('schema: clave adicional en raíz → rechazo', () => {
  const cfg = configValida();
  cfg.templates = {};
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: adapter fuera de enum → rechazo', () => {
  const cfg = configValida();
  cfg.engines.tts[0].adapter = 'elevenlabs';
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: rate 1000 (say) → rechazo — contrato nuevo con dientes', () => {
  const cfg = configValida();
  cfg.engines.tts[0].rate = 1000;
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: pitch_scale 1.5 → rechazo a tiempo de config (H5)', () => {
  const cfg = configValida();
  cfg.engines.tts[0].adapter = 'kokoro';
  cfg.engines.tts[0].pitch_scale = 1.5;
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: max_text_chars 5000 → rechazo (tope duro 2000, H1)', () => {
  const cfg = configValida();
  cfg.constraints = { max_text_chars: 5000 };
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: motor sin kill_switch → rechazo', () => {
  const cfg = configValida();
  delete cfg.engines.tts[0].kill_switch;
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: clave extra dentro del motor → rechazo', () => {
  const cfg = configValida();
  cfg.engines.tts[0].lang = 'es';
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: kill_switch.target inventado → rechazo', () => {
  const cfg = configValida();
  cfg.engines.tts[0].kill_switch.target = 'thread';
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: max_latency_ms 50 (bajo el piso 100) → rechazo', () => {
  const cfg = configValida();
  cfg.engines.tts[0].kill_switch.max_latency_ms = 50;
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: rate string "rapido" → rechazo de tipo', () => {
  const cfg = configValida();
  cfg.engines.tts[0].rate = 'rapido';
  assert.notEqual(validar(cfg, schema).length, 0);
});

test('schema: sin engines.stt → rechazo (estructura de matriz)', () => {
  const errores = validar({ engines: { tts: [] } }, schema);
  assert.notEqual(errores.length, 0);
});

// —— ronda adversarial: puntos ciegos del validador ——

test('validador: schema booleano false rechaza TODO (draft-07)', () => {
  const errores = validar('cualquiera', false);
  assert.notEqual(errores.length, 0);
});

test('validador: schema booleano true acepta todo', () => {
  assert.deepEqual(validar({ lo: 'que sea' }, true), []);
});

test('validador: items en forma tupla → rechazo ruidoso, no silencio', () => {
  const errores = validar(['x', 3], { type: 'array', items: [{ type: 'integer' }] });
  assert.notEqual(errores.length, 0);
});

// —— vigilancia meta: schema y validador crecen juntos ——

test('schema: sólo usa palabras clave que el validador implementa', () => {
  const implementadas = new Set([
    '$ref', 'definitions', 'type', 'enum', 'minimum', 'maximum',
    'exclusiveMinimum', 'minLength', 'maxLength', 'pattern', 'items',
    'minItems', 'properties', 'additionalProperties', 'required',
    // anotaciones: se ignoran al validar
    '$schema', '$id', 'title', 'description', 'deprecated',
  ]);
  const encontradas = new Set();
  // Walker consciente de estructura: sólo recorre posiciones-esquema
  // (definitions/properties/items/additionalProperties-esquema). Una
  // palabra clave NUEVA que introduzca subschemas y no esté en la
  // lista aparece como desconocida: fail-closed.
  const caminar = (nodo) => {
    if (!nodo || typeof nodo !== 'object') return;
    for (const k of Object.keys(nodo)) encontradas.add(k);
    const sub = [
      ...Object.values(nodo.definitions ?? {}),
      ...Object.values(nodo.properties ?? {}),
    ];
    if (nodo.items) sub.push(nodo.items);
    if (nodo.additionalProperties && typeof nodo.additionalProperties === 'object') {
      sub.push(nodo.additionalProperties);
    }
    sub.forEach(caminar);
  };
  caminar(schema);
  const desconocidas = [...encontradas].filter((k) => !implementadas.has(k));
  assert.deepEqual(desconocidas, [],
    `el schema usa palabras clave sin validador: ${desconocidas}`);
});
