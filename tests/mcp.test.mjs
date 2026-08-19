import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CATALOGO } from '../src/plantillas.mjs';

const RAIZ = new URL('..', import.meta.url).pathname;

// Cliente stdio real: un proceso por test, respuestas correladas por id.
// Sin mocks internos: el contrato es observable por proceso (política repo).
class Cliente {
  constructor() {
    this.child = spawn('node', ['src/mcp.mjs'], { cwd: RAIZ });
    this.respuestas = [];
    this.orden = [];
    this.esperas = new Map();
    this.buf = '';
    this.child.stdout.on('data', (d) => this.#alRecibir(d));
    this.child.on('error', (e) => {
      for (const [, rej] of this.esperas) rej(e);
    });
    // degradación suave: SIGINT deja que el servidor mate sus grupos hijos
    // (un say detached sobreviviría al SIGKILL del padre); SIGKILL de respaldo
    this.guard = setTimeout(() => {
      this.child.kill('SIGINT');
      setTimeout(() => this.child.kill('SIGKILL'), 1000).unref();
    }, 20000);
    this.guard.unref();
  }

  #alRecibir(d) {
    this.buf += d.toString();
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const l = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!l.trim()) continue;
      let r;
      try {
        r = JSON.parse(l);
      } catch {
        // stdout contaminado con una línea no-JSON: exactamente la clase
        // de bug que esta suite vigila; se registra, no se revienta el runner
        r = { id: undefined, __ilegible: l.slice(0, 120) };
      }
      this.respuestas.push(r);
      this.orden.push(r.id);
      const esp = this.esperas.get(r.id);
      if (esp) {
        this.esperas.delete(r.id);
        esp(r);
      }
    }
  }

  enviar(obj) {
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  lineaCruda(l) {
    this.child.stdin.write(`${l}\n`);
  }

  esperar(id, ms = 10000) {
    const ya = this.respuestas.find((r) => r.id === id);
    if (ya) return Promise.resolve(ya);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.esperas.delete(id);
        reject(new Error(`sin respuesta para id ${id}`));
      }, ms);
      this.esperas.set(id, (r) => {
        clearTimeout(t);
        resolve(r);
      });
    });
  }

  async cerrar() {
    clearTimeout(this.guard);
    this.child.stdin.end();
    await new Promise((res) => this.child.on('close', res));
  }
}

// limpieza garantizada aunque el cuerpo falle (ronda adversarial M1)
async function conCliente(fn) {
  const c = new Cliente();
  try {
    await fn(c);
  } finally {
    await c.cerrar();
  }
}

function llamada(id, name, arguments_ = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } };
}

function sesionDePrueba(overrides = {}) {
  return {
    schema: 'glosomata/sesion-v1',
    id: '11111111-1111-4111-8111-111111111111',
    template: CATALOGO.confirmar,
    turn: 0,
    created_at: new Date().toISOString(),
    ttl_min: 15,
    ...overrides,
  };
}

test('MCP: initialize y tools/list por stdio', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    } });
    c.enviar({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const [init, lista] = await Promise.all([c.esperar(1), c.esperar(2)]);
    assert.equal(init.result.protocolVersion, '2024-11-05');
    assert.equal(init.result.serverInfo.name, 'glosomata');
    assert.equal(lista.result.tools.length, 6);
  });
});

test('MCP: inputSchema cerrados y rangos de timeout', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const { result: { tools } } = await c.esperar(1);
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
});

test('MCP: ping responde result vacío', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const r = await c.esperar(1);
    assert.deepEqual(r.result, {});
    assert.equal(r.error, undefined);
  });
});

test('MCP: método desconocido con id → -32601, no cuelga', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 7, method: 'resources/list', params: {} });
    const r = await c.esperar(7);
    assert.equal(r.id, 7);
    assert.equal(r.error.code, -32601);
    assert.equal(r.result, undefined);
  });
});

test('MCP: notificaciones (conocidas o no) sin id → silencio', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', method: 'notifications/rotated' });
    c.enviar({ jsonrpc: '2.0', method: 'ping' });
    c.enviar({ jsonrpc: '2.0', id: 3, method: 'ping' });
    await c.esperar(3);
    // sólo la respuesta con id 3: ninguna respuesta sin id, ninguna a notificaciones
    assert.equal(c.respuestas.length, 1);
    assert.equal(c.respuestas[0].id, 3);
    assert.ok(!c.respuestas.some((r) => r.__ilegible), 'stdout contaminado');
  });
});

test('MCP: línea ilegible → -32700 con id null', async () => {
  await conCliente(async (c) => {
    c.lineaCruda('{esto no es json');
    c.enviar({ jsonrpc: '2.0', id: 5, method: 'ping' });
    await c.esperar(5);
    const parseErr = c.respuestas.find((r) => r.error?.code === -32700);
    assert.ok(parseErr, 'debe existir respuesta -32700');
    assert.equal(parseErr.id, null);
  });
});

test('MCP: null / primitivo / batch → -32600 con id null, sin morir', async () => {
  await conCliente(async (c) => {
    c.lineaCruda('null');
    c.lineaCruda('42');
    c.lineaCruda('[{"jsonrpc":"2.0","id":9,"method":"ping"}]');
    c.enviar({ jsonrpc: '2.0', id: 5, method: 'ping' });
    await c.esperar(5);
    const invalidos = c.respuestas.filter((r) => r.error?.code === -32600);
    assert.equal(invalidos.length, 3);
    for (const r of invalidos) assert.equal(r.id, null);
  });
});

test('MCP: request con id pero sin method → -32600 con echo de id', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 11, params: {} });
    const r = await c.esperar(11);
    assert.equal(r.id, 11);
    assert.equal(r.error.code, -32600);
  });
});

test('MCP: tools/call sin params → -32602 y el servidor sigue vivo', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
    c.enviar({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const [r1, r2] = await Promise.all([c.esperar(1), c.esperar(2)]);
    assert.equal(r1.error.code, -32602);
    assert.deepEqual(r2.result, {});
  });
});

test('MCP: tools/call speak sin text → usage, isError', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'speak', {}));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    assert.equal(JSON.parse(r.result.content[0].text).error, 'usage');
  });
});

test('MCP: tools/call speak con engine inexistente → engine_unavailable', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'speak', { text: 'hola', engine: 'no-existe' }));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    assert.equal(JSON.parse(r.result.content[0].text).error, 'engine_unavailable');
  });
});

test('MCP: validate ok → isError false y next_turn 1', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'validate', { session: sesionDePrueba(), text: 'sí' }));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, false);
    const data = JSON.parse(r.result.content[0].text);
    assert.equal(data.result, 'ok');
    assert.equal(data.next_turn, 1);
  });
});

test('MCP: validate fail → isError true y result fail', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'validate', { session: sesionDePrueba(), text: 'nse' }));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    const data = JSON.parse(r.result.content[0].text);
    assert.equal(data.result, 'fail');
    assert.equal(data.next_turn, 0);
  });
});

test('MCP: validate sesión expirada → session_expired', async () => {
  await conCliente(async (c) => {
    const ses = sesionDePrueba({ created_at: '2020-01-01T00:00:00.000Z' });
    c.enviar(llamada(1, 'validate', { session: ses, text: 'sí' }));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    assert.equal(JSON.parse(r.result.content[0].text).error, 'session_expired');
  });
});

test('MCP: stop durante speak largo → speak truncated, stop atendido en curso', async (t) => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'list_engines'));
    const engines = await c.esperar(1);
    const tts = JSON.parse(engines.result.content[0].text).tts;
    const motor = tts.find((e) => e.id === 'say' && e.available)
      ?? tts.find((e) => e.available);
    if (!motor) {
      t.skip('sin motor TTS disponible en este entorno');
      return;
    }
    const textoLargo = 'prueba de interrupción por kill switch. '.repeat(40);
    const t0 = Date.now();
    c.enviar(llamada(2, 'speak', { text: textoLargo, engine: motor.id }));
    await new Promise((res) => setTimeout(res, 200));
    c.enviar(llamada(3, 'stop'));
    const [rStop, rSpeak] = await Promise.all([c.esperar(3), c.esperar(2)]);
    const transcurrido = Date.now() - t0;
    // con despacho secuencial (regresión de ronda 3), stop esperaría a que
    // el speak agote ~80s de audio; con despacho concurrente, ambos quedan
    // resueltos en el orden de cientos de ms
    assert.ok(transcurrido < 10000,
      `stop atendido en ${transcurrido}ms; ¿despacho secuencial regresó?`);
    assert.equal(rStop.result.isError, false);
    assert.equal(JSON.parse(rStop.result.content[0].text).stopped, true);
    // el speak se resuelve con isError y truncated, no se pierde
    assert.equal(rSpeak.result.isError, true);
    const data = JSON.parse(rSpeak.result.content[0].text);
    assert.equal(data.played, false);
    assert.equal(data.truncated, true);
  });
});
