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

// Error JSON-RPC 2.0 estándar. id null cuando es indetectable (parse).
// Sin esto, un método desconocido dejaba al cliente esperando para siempre
// (hallazgo #1, verificación 2026-08-18).
// Escritura por línea con reintento: stdout no-bloqueante puede aceptar
// escrituras parciales; el retorno de writeSync no se ignora. Form Buffer:
// (fd, buf, offset, length) — el form string trata el 3er arg como position
// y lanza ESPIPE contra un pipe.
function escribirLinea(obj) {
  const b = Buffer.from(`${JSON.stringify(obj)}\n`);
  let off = 0;
  try {
    while (off < b.length) off += writeSync(1, b, off, b.length - off);
  } catch {
    // stdout roto (cliente muerto): sin lector no hay protocolo; salida
    // limpia por stderr en vez de unhandled con stack (ronda 5, L-5)
    process.stderr.write('glosomata-mcp: stdout roto, terminando\n');
    process.exit(1);
  }
}

function rpc(id, result) {
  escribirLinea({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  escribirLinea({ jsonrpc: '2.0', id, error: { code, message } });
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
      rpcError(null, -32700, 'Parse error');
      continue;
    }
    // Envelope válido = objeto plano con method. null, primitivos y arrays
    // (batch, no soportado en MCP 2024-11-05) son Invalid Request; sin
    // esto, `null` o `{id}` reventaban el loop (ronda adversarial).
    const esObjeto = msg !== null && typeof msg === 'object'
      && !Array.isArray(msg);
    const { id, method, params } = esObjeto ? msg : {};
    if (typeof method !== 'string') {
      rpcError(esObjeto && id !== undefined ? id : null,
        -32600, 'Invalid Request');
      continue;
    }
    if (method === 'initialize') {
      rpc(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'glosomata', version: '0.1.0-alpha.2' },
      });
    } else if (method === 'notifications/initialized') {
      // notificación: sin respuesta
    } else if (method === 'tools/list') {
      rpc(id, { tools: TOOLS });
    } else if (method === 'tools/call') {
      // params debe ser objeto con name string: si no, TypeError síncrono
      // fuera de la promesa mataba el servidor (ronda adversarial).
      if (params === null || typeof params !== 'object'
          || typeof params.name !== 'string') {
        rpcError(id, -32602, 'Invalid params');
        continue;
      }
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
    } else if (method === 'ping') {
      if (id !== undefined) rpc(id, {});
    } else if (id !== undefined) {
      // request desconocido → error estándar; notificación (sin id) →
      // silencio, como manda JSON-RPC 2.0.
      rpcError(id, -32601, 'Method not found');
    }
  }
}
