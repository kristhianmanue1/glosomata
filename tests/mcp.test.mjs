import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const RAIZ = new URL('..', import.meta.url).pathname;

function linea(method, params, id) {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

// servidor stdio real: initialize + tools/list, cierre de stdin → exit
function sesionMcp() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['src/mcp.mjs'], { cwd: RAIZ });
    const respuestas = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (l.trim()) respuestas.push(JSON.parse(l));
      }
    });
    child.on('close', () => resolve(respuestas));
    child.on('error', reject);
    const guard = setTimeout(() => child.kill('SIGKILL'), 5000);
    guard.unref();
    child.stdin.write(linea('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    }, 1));
    child.stdin.write(linea('tools/list', {}, 2));
    child.stdin.end();
  });
}

test('MCP: initialize y tools/list por stdio', async () => {
  const [init, lista] = await sesionMcp();
  assert.equal(init.id, 1);
  assert.equal(init.result.serverInfo.name, 'glosomata');
  assert.equal(lista.id, 2);
  const tools = lista.result.tools;
  assert.equal(tools.length, 6);
});

test('MCP: inputSchema cerrados y rangos de timeout', async () => {
  const [, lista] = await sesionMcp();
  const tools = lista.result.tools;
  // cerrado: sin propiedades extra aceptadas (LOW ronda 3)
  for (const t of tools) {
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
  }
  const listen = tools.find((t) => t.name === 'listen');
  const ts = listen.inputSchema.properties.timeout_s;
  assert.equal(ts.exclusiveMinimum, 0); // alineado con stt: v > 0
  assert.equal(ts.maximum, 120); // alineado con stt: v ≤ 120
  const speak = tools.find((t) => t.name === 'speak');
  assert.deepEqual(speak.inputSchema.required, ['text']);
  const validate = tools.find((t) => t.name === 'validate');
  assert.deepEqual(validate.inputSchema.required, ['session', 'text']);
});
