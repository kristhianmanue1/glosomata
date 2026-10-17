// Contrato de señales del canal (H2, análisis 2026-10-17): SIGINT trunca
// sin terminar el proceso (es la señal del stop cross-process); SIGTERM
// trunca y termina. Verificado por proceso real, sin mocks. Limpieza con
// t.after y tope de espera en cada exit (ronda adversarial, H5).

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const FIXTURE = fileURLToPath(new URL('./fixtures/proceso-senales.mjs', import.meta.url));

function arrancar(t) {
  const child = spawn(process.execPath, [FIXTURE]);
  child.stderr.on('data', () => {}); // drenar (política de logs)
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
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

// exit con tope: un handler que no corriera debe fallar el test, no
// colgar la suite.
async function esperarExit(child) {
  const ac = new AbortController();
  const tope = setTimeout(() => ac.abort(), 5000);
  try {
    return await once(child, 'exit', { signal: ac.signal });
  } finally {
    clearTimeout(tope);
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

test('SIGINT trunca pero NO termina el proceso (señal del stop)', async (t) => {
  const child = arrancar(t);
  await esperarListo(child);
  child.kill('SIGINT');
  await dormir(400);
  assert.equal(child.exitCode, null, 'el proceso sigue vivo tras SIGINT');
  child.kill('SIGTERM');
  await esperarExit(child);
});

test('SIGTERM termina el proceso con exit 143 cuando la gracia decide (H2)', async (t) => {
  const child = arrancar(t);
  await esperarListo(child);
  child.kill('SIGTERM');
  const [code, signal] = await esperarExit(child);
  assert.equal(signal, null, 'termina por exit del handler, no por señal');
  assert.equal(code, 143);
});

test('SIGTERM repetida: termina una sola vez con 143 (POSIX puede coalescer)', async (t) => {
  const child = arrancar(t);
  await esperarListo(child);
  child.kill('SIGTERM');
  child.kill('SIGTERM');
  const [code] = await esperarExit(child);
  assert.equal(code, 143);
});
