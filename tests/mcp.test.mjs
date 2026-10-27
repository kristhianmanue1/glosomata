import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOGO } from '../src/plantillas.mjs';

const RAIZ = new URL('..', import.meta.url).pathname;

// Cliente stdio real: un proceso por test, respuestas correladas por id.
// Sin mocks internos: el contrato es observable por proceso (política repo).
class Cliente {
  constructor(extra = {}) {
    this.runtimeDir = mkdtempSync(join(tmpdir(), 'glosomata-mcp-'));
    this.child = spawn('node', ['src/mcp.mjs'], {
      cwd: RAIZ,
      env: { ...process.env, GLOSOMATA_RUNTIME: this.runtimeDir, ...extra },
    });
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
    rmSync(this.runtimeDir, { recursive: true, force: true });
  }
}

// limpieza garantizada aunque el cuerpo falle (ronda adversarial M1)
async function conCliente(fn, extra = {}) {
  const c = new Cliente(extra);
  try {
    await fn(c);
  } finally {
    await c.cerrar();
  }
}

async function waitForLock(c) {
  const lock = join(c.runtimeDir,
    `glosomata-${process.getuid()}`, 'canal.lock');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(lock)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('speak no adquirió el lock dentro de 5 segundos');
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
    // serverInfo.version desde package.json: misma fuente que CLI version
    // (C0.1 — sin hardcode ni drift)
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(init.result.serverInfo.version, pkg.version);
    assert.equal(lista.result.tools.length, 8);
  });
});

test('MCP: initialize negocia protocolVersion (eco soportada, tope si no)', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05' } });
    c.enviar({ jsonrpc: '2.0', id: 2, method: 'initialize',
      params: { protocolVersion: '1999-01-01' } });
    c.enviar({ jsonrpc: '2.0', id: 3, method: 'initialize',
      params: { protocolVersion: '2026-01-01' } });
    c.enviar({ jsonrpc: '2.0', id: 4, method: 'initialize' }); // sin params
    const [r1, r2, r3, r4] = await Promise.all([
      c.esperar(1), c.esperar(2), c.esperar(3), c.esperar(4)]);
    assert.equal(r1.result.protocolVersion, '2024-11-05'); // eco
    assert.equal(r2.result.protocolVersion, '2024-11-05'); // tope
    assert.equal(r3.result.protocolVersion, '2024-11-05'); // tope
    assert.equal(r4.result.protocolVersion, '2024-11-05'); // default
  });
});

test('MCP: session_new sin template → sesión v1 con template null', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'session_new'));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, false);
    const ses = JSON.parse(r.result.content[0].text);
    assert.equal(ses.schema, 'glosomata/sesion-v1');
    assert.equal(ses.template, null);
    assert.equal(ses.turn, 0);
  });
});

test('MCP: session_new con template_id builtin incrusta plantilla', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'session_new', { template_id: 'confirmar' }));
    const r = await c.esperar(1);
    const ses = JSON.parse(r.result.content[0].text);
    assert.equal(ses.template.id, 'confirmar');
    assert.equal(ses.turn, 0);
  });
});

test('MCP: session_new id desconocido → not_found; id malformado → template_invalid', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'session_new', { template_id: 'no-existe' }));
    c.enviar(llamada(2, 'session_new', { template_id: '../etc/passwd' }));
    const [r1, r2] = await Promise.all([c.esperar(1), c.esperar(2)]);
    assert.equal(JSON.parse(r1.result.content[0].text).error, 'not_found');
    assert.equal(JSON.parse(r2.result.content[0].text).error, 'template_invalid');
  });
});

test('MCP: list_templates incluye turns (agente MCP-only autónomo)', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'list_templates'));
    const r = await c.esperar(1);
    const lista = JSON.parse(r.result.content[0].text);
    const confirmar = lista.find((t) => t.id === 'confirmar');
    assert.ok(confirmar, 'catalogo sin confirmar');
    assert.deepEqual(confirmar.turns,
      [{ expectation: 'exact', pattern: 'sí|no|si' }]);
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
    const data = JSON.parse(r.result.content[0].text);
    assert.equal(data.error, 'usage');
    assert.ok(Number.isInteger(data.duration_ms) && data.duration_ms >= 0);
  });
});

test('MCP: tools/call speak con engine inexistente → engine_unavailable', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'speak', { text: 'hola', engine: 'no-existe' }));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    const data = JSON.parse(r.result.content[0].text);
    assert.equal(data.error, 'engine_unavailable');
    assert.ok(Number.isInteger(data.duration_ms) && data.duration_ms >= 0);
  });
});

test('MCP: excepción de config se codifica como JSON de operación', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'get_config'));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    assert.deepEqual(JSON.parse(r.result.content[0].text),
      { error: 'config_unreadable' });
  }, { GLOSOMATA_CONFIG: '/ruta-inexistente/glosomata.json' });
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

test('MCP: validate sin schema / schema ajeno / array → session_invalid (C1.3)', async () => {
  await conCliente(async (c) => {
    const sinSchema = sesionDePrueba();
    delete sinSchema.schema;
    const schemaAjeno = sesionDePrueba({ schema: 'otra/cosa' });
    c.enviar(llamada(1, 'validate', { session: sinSchema, text: 'sí' }));
    c.enviar(llamada(2, 'validate', { session: schemaAjeno, text: 'sí' }));
    c.enviar(llamada(3, 'validate', { session: [1, 2], text: 'sí' }));
    const [r1, r2, r3] = await Promise.all([
      c.esperar(1), c.esperar(2), c.esperar(3)]);
    for (const r of [r1, r2, r3]) {
      assert.equal(r.result.isError, true);
      assert.equal(JSON.parse(r.result.content[0].text).error, 'session_invalid');
    }
  });
});

// —— P2.1: get_config sana (frontera de divulgación) ——

test('MCP: get_config devuelve la matriz saneada — forma exacta', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'get_config'));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, false);
    const cfg = JSON.parse(r.result.content[0].text);
    assert.ok(Array.isArray(cfg.engines.tts) && cfg.engines.tts.length > 0);
    for (const m of cfg.engines.tts) {
      // whitelist: nada más que esto
      assert.deepEqual(Object.keys(m).sort(),
        ['adapter', 'available', 'id', 'kill_switch', 'selected']);
      assert.deepEqual(Object.keys(m.kill_switch), ['max_latency_ms']);
      assert.equal(typeof m.kill_switch.max_latency_ms, 'number');
    }
    assert.deepEqual(Object.keys(cfg.engines.stt), ['available']);
    assert.ok(cfg.constraints && typeof cfg.constraints === 'object');
  });
});

test('MCP: get_config NO expone ni una ruta del disco (config real con rutas)', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'get_config'));
    const r = await c.esperar(1);
    // sin esto, un fallo del servidor pasaría el test en vacío (ADV H-4)
    assert.equal(r.result.isError, false);
    const plano = r.result.content[0].text;
    // la config real del repo declara bin/python/model/script/whisper_*:
    // ninguna de esas claves ni valores puede viajar — incluidas las
    // rutas RELATIVAS de la config real, no sólo las absolutas
    for (const prohibida of ['"bin"', '"model"', '"python"', '"script"',
      'whisper_bin', 'whisper_model', '.venv', '/Users/',
      'docs/proposal', 'whisper-cli', 'ggml', '.local-models']) {
      assert.equal(plano.includes(prohibida), false, prohibida);
    }
  });
});

test('MCP: get_config ante config envenenada a mano — null, nunca verbatim', async () => {
  // canal vigente según ADR-008 §Contexto: config editada a mano, sin
  // schema. Basura en id/adapter/max_latency_ms y rutas coladas en
  // constraints → el saneador fail-closed viaja con nulls/omisiones.
  const dir = mkdtempSync(join(tmpdir(), 'glo-adv-gc-'));
  const rutaCfg = join(dir, 'glosomata.json');
  writeFileSync(rutaCfg, JSON.stringify({
    engines: {
      tts: [
        { id: '/Users/victima/.ssh/id_ed25519', adapter: '/bin/sh',
          selected: true, available: false,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: '/Users/victima/secreto/planta' } },
        { id: 'sin-ks', adapter: 'say', selected: false },
      ],
      stt: {},
    },
    constraints: {
      session_ttl_min: 15,
      nota_interna: '/Users/victima/.local-models/ggml-small.bin',
      stt_extra: { whisper_bin: '.local-models/whisper-cli' },
      max_text_chars: 'dos mil',
    },
  }));
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'get_config'));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, false);
    const cfg = JSON.parse(r.result.content[0].text);
    assert.equal(cfg.engines.tts[0].id, null);
    assert.equal(cfg.engines.tts[0].adapter, null);
    assert.equal(cfg.engines.tts[0].kill_switch.max_latency_ms, null);
    // motor sin kill_switch: forma estable, valor null (ADV H-5)
    assert.deepEqual(cfg.engines.tts[1].kill_switch, { max_latency_ms: null });
    // constraints: sólo claves conocidas con número finito
    assert.deepEqual(cfg.constraints, { session_ttl_min: 15 });
    const plano = r.result.content[0].text;
    for (const prohibida of ['.ssh', 'secreto', 'ggml', 'whisper',
      'nota_interna', 'stt_extra']) {
      assert.equal(plano.includes(prohibida), false, prohibida);
    }
  }, { GLOSOMATA_CONFIG: rutaCfg });
});

test('MCP: get_config con arguments array → usage (no es objeto)', async () => {
  await conCliente(async (c) => {
    c.enviar({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'get_config', arguments: [] } });
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    assert.equal(JSON.parse(r.result.content[0].text).error, 'usage');
  });
});

test('MCP: get_config con args inesperados → usage (schema cerrado)', async () => {
  await conCliente(async (c) => {
    c.enviar(llamada(1, 'get_config', { todo: true }));
    const r = await c.esperar(1);
    assert.equal(r.result.isError, true);
    assert.equal(JSON.parse(r.result.content[0].text).error, 'usage');
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
    await waitForLock(c);
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
    assert.equal(data.played, false,
      `error=${data.error ?? 'none'}, truncated=${data.truncated ?? 'none'}`);
    assert.equal(data.truncated, true);
    assert.ok(Number.isInteger(data.duration_ms) && data.duration_ms >= 0);
  });
});

test('MCP: stop inmediato tras speak no se pierde durante imports', async (t) => {
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
    c.enviar(llamada(2, 'speak', {
      text: 'interrumpir el arranque. '.repeat(40), engine: motor.id,
    }));
    c.enviar(llamada(3, 'stop'));
    const [speak, stop] = await Promise.all([c.esperar(2), c.esperar(3)]);
    assert.equal(stop.result.isError, false);
    assert.equal(speak.result.isError, true);
    const data = JSON.parse(speak.result.content[0].text);
    assert.equal(data.played, false);
    assert.equal(data.truncated, true);
    assert.ok(Number.isInteger(data.duration_ms) && data.duration_ms >= 0);
  });
});
