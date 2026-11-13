import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  argsCaptura, causaFormaNombre, crearDetectorFin, rutaTono,
} from '../src/stt.mjs';

test('argsCaptura: darwin usa avfoundation', () => {
  const c = argsCaptura('darwin');
  assert.deepEqual(c.input, ['-f', 'avfoundation', '-i', ':0']);
  assert.ok(c.bin.endsWith('ffmpeg'));
});

test('argsCaptura: darwin sin nombre → :0 INTACTO (conducta original)', () => {
  // ambos modos de llamada: explícito undefined y sin segundo argumento
  assert.deepEqual(argsCaptura('darwin', undefined).input,
    ['-f', 'avfoundation', '-i', ':0']);
  assert.deepEqual(argsCaptura('darwin').input,
    ['-f', 'avfoundation', '-i', ':0']);
});

test('argsCaptura: darwin con nombre → binding por NOMBRE exacto (G2a)', () => {
  const c = argsCaptura('darwin', 'Entrada Uno');
  assert.deepEqual(c.input, ['-f', 'avfoundation', '-i', ':Entrada Uno']);
  // el id numérico del listado jamás viaja: nunca `:0` cuando hay nombre
  assert.notEqual(c.input[3], ':0');
  assert.ok(!/^\d+$/.test(c.input[3].slice(1)), 'input sin índice desnudo');
});

test('argsCaptura: linux con nombre → fail-closed (la selección no existe)', () => {
  assert.equal(argsCaptura('linux', 'Entrada Uno'), null);
  // sin nombre: conducta original intacta
  assert.deepEqual(argsCaptura('linux').input, ['-f', 'alsa', '-i', 'default']);
});

test('argsCaptura: plataforma sin soporte → fail-closed (null)', () => {
  assert.equal(argsCaptura('win32'), null);
  assert.equal(argsCaptura('freebsd'), null);
  assert.equal(argsCaptura(undefined), null);
  // incluso con nombre: fail-closed gana
  assert.equal(argsCaptura('win32', 'Entrada Uno'), null);
});

// —— G2a: forma del nombre exacto (la MISMA regla que config validate) ——

test('forma: válida → null', () => {
  for (const v of ['Entrada Uno', 'Entrada Externa Generica', '0', '-guión',
    'a b  c', 'Micrófono Generico (USB)']) {
    assert.equal(causaFormaNombre(v), null, v);
  }
});

test('forma: vacío → usage', () => {
  assert.equal(causaFormaNombre(''), 'vacio');
  assert.equal(causaFormaNombre(undefined), 'vacio');
  assert.equal(causaFormaNombre(null), 'vacio');
  assert.equal(causaFormaNombre(42), 'vacio');
});

test('forma: dos puntos o comillas → charset (rompen -i "[V]:[A]")', () => {
  for (const v of ['a:b', ':', 'Entrada: Uno', 'con "comillas"',
    "con 'comillas'", 'mixto:"x']) {
    assert.equal(causaFormaNombre(v), 'charset', v);
  }
});

test('forma: alias reservados del backend → alias, exactos', () => {
  assert.equal(causaFormaNombre('default'), 'alias');
  assert.equal(causaFormaNombre('none'), 'alias');
  // no exactos: un dispositivo legítimo puede CONTENER la palabra
  assert.equal(causaFormaNombre('Default Output'), null);
  assert.equal(causaFormaNombre('nonexistent'), null);
});

// Fin de turno por silencio: tramos de 100 ms (3200 bytes s16le)
const tramo = (amp) => {
  const b = Buffer.alloc(3200);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(amp, i);
  return b;
};
const alimentar = (d, tramos) => tramos.map((t) => d.alimentar(t));

test('detector: voz y luego 1.5 s de silencio corta en el tramo 15', () => {
  const d = crearDetectorFin();
  const r = alimentar(d, [
    ...Array(3).fill(tramo(50)), // calibración
    ...Array(5).fill(tramo(3000)), // voz
    ...Array(15).fill(tramo(50)), // silencio
  ]);
  assert.equal(r.indexOf(true), r.length - 1);
});

test('detector: pausa de 1 s para pensar ya no corta', () => {
  const d = crearDetectorFin();
  const r = alimentar(d, [
    ...Array(3).fill(tramo(50)),
    ...Array(5).fill(tramo(3000)),
    ...Array(10).fill(tramo(50)), // 1 s: antes cortaba aquí
    ...Array(5).fill(tramo(3000)),
  ]);
  assert.ok(r.every((x) => !x));
});

test('detector: sólo silencio jamás corta (decide el timeout)', () => {
  const d = crearDetectorFin();
  assert.ok(alimentar(d, Array(100).fill(tramo(50))).every((x) => !x));
});

test('detector: pausa corta dentro del habla no corta', () => {
  const d = crearDetectorFin();
  const r = alimentar(d, [
    ...Array(3).fill(tramo(50)),
    ...Array(5).fill(tramo(3000)),
    ...Array(6).fill(tramo(50)), // pausa de 600 ms
    ...Array(5).fill(tramo(3000)),
  ]);
  assert.ok(r.every((x) => !x));
});

test('detector: tramos partidos en trozos arbitrarios equivalen', () => {
  const d = crearDetectorFin();
  const todo = Buffer.concat([
    ...Array(3).fill(tramo(50)), ...Array(5).fill(tramo(3000)),
    ...Array(15).fill(tramo(50)),
  ]);
  let corto = false;
  for (let i = 0; i < todo.length; i += 1000) {
    corto = d.alimentar(todo.subarray(i, i + 1000)) || corto;
  }
  assert.ok(corto);
});

test('rutaTono: darwin suena Tink por defecto; otras plataformas sin tono', () => {
  assert.equal(rutaTono('darwin', {}), '/System/Library/Sounds/Tink.aiff');
  assert.equal(rutaTono('linux', {}), null);
});

test('rutaTono: GLOSOMATA_TONO vacío apaga y una ruta lo reemplaza', () => {
  assert.equal(rutaTono('darwin', { GLOSOMATA_TONO: '' }), null);
  assert.equal(rutaTono('darwin', { GLOSOMATA_TONO: '/x/t.aiff' }), '/x/t.aiff');
});
