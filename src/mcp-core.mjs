// Núcleo MCP stdio — JSON-RPC mínimo: initialize, tools/list, tools/call.
import { readFileSync } from 'node:fs';

const TOOLS = [
  { name: 'speak', description: 'Reproduce texto por voz localmente',
    inputSchema: { type: 'object', required: ['text'],
      properties: { text: { type: 'string', maxLength: 2000 },
        engine: { type: 'string' } } } },
  { name: 'listen', description: 'Captura micrófono y devuelve transcripción',
    inputSchema: { type: 'object',
      properties: { timeout_s: { type: 'number', default: 10 } } } },
  { name: 'stop', description: 'Interrumpe la operación de canal activa',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_engines', description: 'Matriz de disponibilidad TTS/STT',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'list_templates', description: 'Plantillas base por tipo',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'validate', description: 'Evalúa texto contra plantilla+turno',
    inputSchema: { type: 'object', required: ['session', 'text'],
      properties: { session: { type: 'object' },
        text: { type: 'string', maxLength: 2000 } } } },
];

function rpc(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function rpcErr(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`
  );
}

async function llamar(name, args) {
  switch (name) {
    case 'speak': {
      const canal = await import('./canal.mjs');
      return canal.speak(['--text', args.text]);
    }
    case 'listen': {
      const canal = await import('./canal.mjs');
      return canal.listen(['--timeout', String(args.timeout_s ?? 10)]);
    }
    case 'stop': {
      const canal = await import('./canal.mjs');
      return canal.stop([]);
    }
    case 'list_engines': {
      const matriz = await import('./matriz.mjs');
      return matriz.engines();
    }
    case 'list_templates': {
      const p = await import('./plantillas.mjs');
      return p.templates(['--list']);
    }
    case 'validate': {
      const p = await import('./plantillas.mjs');
      // sesión inline (objeto), no archivo — mismo contrato de validación
      const out = p.validarTurno(
        args.session?.template, args.session?.turn ?? 0, args.text
      );
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return out.result === 'ok' ? 0 : 1;
    }
    default:
      return 2;
  }
}

export async function main() {
  const entrada = readFileSync(0, 'utf8');
  for (const linea of entrada.split('\n')) {
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
        serverInfo: { name: 'glosomata', version: '0.1.0' },
      });
    } else if (method === 'tools/list') {
      rpc(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      try {
        const code = await llamar(params.name, params.arguments ?? {});
        rpc(id, {
          content: [{ type: 'text', text: 'ok' }],
          isError: code !== 0,
        });
      } catch (e) {
        rpc(id, {
          content: [{ type: 'text', text: e.code ?? 'internal_error' }],
          isError: true,
        });
      }
    }
  }
}
