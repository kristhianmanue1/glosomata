// Contrato de señales del canal (H2, análisis 2026-10-17): SIGINT trunca
// sin terminar el proceso (es la señal del stop cross-process); SIGTERM
// trunca y termina. Verificado por proceso real, sin mocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const FIXTURE = fileURLToPath(new URL('./fixtures/proceso-senales.mjs', import.meta.url));

function arrancar() {
  const child = spawn(process.execPath, [FIXTURE]);
  child.stderr.on('data', () => {}); // drenar (política de logs)
  return child;
}

async function esperarListo(child) {
  let out = '';
  child.stdout.setEncoding('utf8');
  for await (const chunk of child.stdout) {
    out += chunk;
    if (out.includes('listo')) return;
  }
  throw new Error('el fixture terminó antes de estar listo');
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

test('SIGINT trunca pero NO termina el proceso (señal del stop)', async () => {
  const child = arrancar();
  await esperarListo(child);
  child.kill('SIGINT');
  await dormir(400);
  assert.equal(child.exitCode, null, 'el proceso sigue vivo tras SIGINT');
  child.kill('SIGTERM');
  await once(child, 'exit');
});

test('SIGTERM termina el proceso con exit 143 (H2)', async () => {
  const child = arrancar();
  await esperarListo(child);
  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null, 'termina por exit del handler, no por señal');
  assert.equal(code, 143);
});

test('SIGTERM repetida no duplica la salida (guard no reentrante)', async () => {
  const child = arrancar();
  await esperarListo(child);
  child.kill('SIGTERM');
  child.kill('SIGTERM');
  const [code] = await once(child, 'exit');
  assert.equal(code, 143);
});
