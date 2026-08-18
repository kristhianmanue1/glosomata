import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsCaptura } from '../src/stt.mjs';

test('argsCaptura: darwin usa avfoundation', () => {
  const c = argsCaptura('darwin');
  assert.deepEqual(c.input, ['-f', 'avfoundation', '-i', ':0']);
  assert.ok(c.bin.endsWith('ffmpeg'));
});

test('argsCaptura: linux usa alsa', () => {
  const c = argsCaptura('linux');
  assert.deepEqual(c.input, ['-f', 'alsa', '-i', 'default']);
  assert.ok(c.bin.endsWith('ffmpeg'));
});

test('argsCaptura: plataforma sin soporte → fail-closed (null)', () => {
  assert.equal(argsCaptura('win32'), null);
  assert.equal(argsCaptura('freebsd'), null);
  assert.equal(argsCaptura(undefined), null);
});
