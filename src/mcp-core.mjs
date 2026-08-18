// Núcleo MCP stdio — JSON-RPC por líneas, despacho concurrente.
// TODA salida envuelta en rpc(); datos de operaciones, nunca writes sueltos.

import { createInterface } from 'node:readline';
import { writeSync } from 'node:fs';

// Schemas cerrados (additionalProperties:false) y rangos alineados con la
// validación interna: el servidor sigue validando fail-closed aunque el
// cliente no respete el schema (LOW ronda 3).
const TOOLS = [
  { name: 'speak', description: 'Reproduce texto por voz localmente',
    inputSchema: { type: 'object', required: ['text'],
      additionalProperties: false,
      properties: { text: { type: 'string', maxLength: 2000 },
        engine: { type: 'string' } } } },
  { name: 'listen', description: 'Captura micrófono y devuelve transcripción',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: { timeout_s: { type: 'number', default: 10,
        exclusiveMinimum: 0, maximum: 120 } } } },
  { name: 'stop', description: 'Interrumpe la operación de canal activa',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: {} } },
  { name: 'list_engines', description: 'Matriz de disponibilidad TTS/STT',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: {} } },
  { name: 'list_templates', description: 'Plantillas base por tipo',
    inputSchema: { type: 'object', additionalProperties: false,
      properties: {} } },
  { name: 'validate', description: 'Evalúa texto contra plantilla+turno',
    inputSchema: { type: 'object', required: ['session', 'text'],
      additionalProperties: false,
      properties: { session: { type: 'object' },
        text: { type: 'string', maxLength: 2000 } } } },
];

function rpc(id, result) {
  writeSync(1, `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

async function llamar(name, args) {
  const ops = await import('./ops.mjs');
  switch (name) {
    case 'speak': {
      if (typeof args.text !== 'string' || !args.text) {
        return { code: 2, data: { error: 'usage' } };
      }
      return ops.speakMcp(args);
    }
    case 'listen': {
      const argv = ['--timeout', String(args.timeout_s ?? 10)];
      return ops.listenOp(argv);
    }
    case 'stop':
      return ops.stopOp();
    case 'list_engines':
      return ops.enginesOp();
    case 'list_templates':
      return ops.templatesOp([]);
    case 'validate': {
      const { expirada } = await import('./sesion.mjs');
      const { validarTurno } = await import('./plantillas.mjs');
      if (!args.session || typeof args.session !== 'object' ||
          typeof args.text !== 'string') {
        return { code: 2, data: { error: 'usage' } };
      }
      if (expirada(args.session)) {
        return { code: 1, data: { error: 'session_expired' } };
      }
      try {
        const out = validarTurno(
          args.session.template, args.session.turn ?? 0, args.text
        );
        return { code: out.result === 'ok' ? 0 : 1, data: out };
      } catch (e) {
        return { code: 1, data: { error: e.code ?? 'internal_error' } };
      }
    }
    default:
      return { code: 2, data: { error: 'usage' } };
  }
}

export async function main() {
  const rl = createInterface({ input: process.stdin });
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(linea);
    } catch {
      continue;
    }
    const { id, method, params } = msg;
    if (method === 'initialize') {
      rpc(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'glosomata', version: '0.1.0-alpha.1' },
      });
    } else if (method === 'notifications/initialized') {
      // notificación: sin respuesta
    } else if (method === 'tools/list') {
      rpc(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      // despacho concurrente: stop es procesado aunque un speak esté en
      // curso (fix BLOCKER ronda 3). rpc es un único writeSync por línea.
      llamar(params.name, params.arguments ?? {})
        .then((r) => {
          rpc(id, {
            content: [{ type: 'text', text: JSON.stringify(r.data) }],
            isError: r.code !== 0,
          });
        })
        .catch((e) => {
          rpc(id, {
            content: [{ type: 'text', text: e.code ?? 'internal_error' }],
            isError: true,
          });
        });
    }
  }
}
