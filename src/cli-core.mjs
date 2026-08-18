// Despacho CLI v1 — contrato en docs/specs/contrato-cli.md
// Exit codes: 0 ok; 1 error con código en stderr; 2 usage.

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
  template_invalid session_invalid session_expired channel_busy not_supported
  internal_error`;

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(`${USO}\n`);
    return 0;
  }
  const cmds = {
    speak: () => import('./canal.mjs').then((m) => m.speak(rest)),
    listen: () => import('./stt.mjs').then((m) => m.listen(rest)),
    stop: () => import('./canal.mjs').then((m) => m.stop(rest)),
    engines: () => import('./matriz.mjs').then((m) => m.engines()),
    templates: () => import('./plantillas.mjs').then((m) => m.templates(rest)),
    session: () => import('./sesion.mjs').then((m) => m.session(rest)),
    validate: () => import('./plantillas.mjs').then((m) => m.validate(rest)),
  };
  const fn = cmds[cmd];
  if (!fn) {
    process.stderr.write(`glosomata: comando desconocido: ${cmd}\n\n${USO}\n`);
    return 2;
  }
  return fn();
}
