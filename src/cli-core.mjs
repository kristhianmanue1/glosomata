// Despacho CLI v1 — imprime lo que las operaciones retornan.
// Exit codes: 0 ok; 1 error con código en stderr; 2 usage.

import { speakOp, listenOp, stopOp, enginesOp, templatesOp, sessionOp,
  validateOp } from './ops.mjs';

const USO = `uso: glosomata <comando> [opciones]

comandos:
  speak --text <str> [--engine <id>]   reproduce texto localmente
  listen [--timeout <s>]               captura micrófono, imprime transcripción
  stop                                 interrumpe la operación de canal activa
  engines                              lista disponibilidad y selección
  templates [--list | --show <id>]     plantillas base
  session new [--template <id>]        acuña sesión efímera (stdout)
  validate --session <archivo> --text <str>
                                       evalúa texto contra plantilla+turno

errores: engine_unavailable tts_failed stt_failed mic_denied mic_timeout
  template_invalid not_found text_too_long session_invalid session_expired
  session_abandoned channel_busy not_supported config_unreadable usage
  internal_error audio_device_error`;

const COMANDOS = Object.create(null);
Object.assign(COMANDOS, {
  speak: (a) => speakOp(a),
  listen: (a) => listenOp(a),
  stop: () => stopOp(),
  engines: () => enginesOp(),
  templates: (a) => (a[0] === '--list' || a.includes('--list') || a.length === 0 || a[0]?.startsWith('--')
    ? templatesOp(a.filter((x) => x !== '--list'))
    : { code: 2, data: { error: 'usage' } }),
  session: (a) => sessionOp(a),
  validate: (a) => validateOp(a),
});

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`${USO}\n`);
    return 0;
  }
  const fn = Object.prototype.hasOwnProperty.call(COMANDOS, cmd)
    ? COMANDOS[cmd]
    : null;
  if (!fn) {
    process.stderr.write(`glosomata: comando desconocido: ${cmd}\n\n${USO}\n`);
    return 2;
  }
  const r = await fn(rest);
  if (r.code === 2) {
    process.stderr.write(`glosomata: ${r.data.error}\n`);
    return 2;
  }
  if (r.code === 0) {
    if (r.data !== undefined) process.stdout.write(`${JSON.stringify(r.data, null, 2)}\n`);
    return 0;
  }
  if (r.data?.error) {
    const { error, ...resto } = r.data;
    process.stderr.write(`glosomata: ${error}${Object.keys(resto).length ? ` (${JSON.stringify(resto)})` : ''}\n`);
    return r.code;
  }
  // resultado no-ok sin campo error (p.ej. interrupted): datos por stdout
  process.stdout.write(`${JSON.stringify(r.data, null, 2)}\n`);
  return r.code;
}
