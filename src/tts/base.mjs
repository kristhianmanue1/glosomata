// Motor base: spawn en grupo propio + kill del grupo + texto SIEMPRE por
// stdin (argv visible en ps — política REQ-6, ADR-005).

import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

export function argvMotor(cfg) {
  // cada adaptador construye argv SIN texto: sólo flags, modelo, rutas
  throw new Error('no implementado');
}

export async function reproducirSubprocess(cfg, argv, texto, { alChunk } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(argv[0], argv.slice(1));
    let terminoLimpio = false;
    let bytesSalida = 0;

    child.stderr.on('data', (d) => {
      // stderr del motor: se descarta contenido (política de logs) — sólo
      // nos importa si el proceso murió con código != 0
    });

    // motores que emiten audio crudo por stdout (piper --output-raw): el
    // adaptador decide qué hacer con los chunks; el polling de stop corre
    // aquí para que NINGÚN hilo externo toque el contexto del motor.
    const poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        matarGrupo(child);
        resolve({ played: false, echo: null, truncated: true });
      }
    }, 50);

    child.on('error', (e) => {
      clearInterval(poll);
      const err = new Error('tts_failed');
      err.code = 'tts_failed';
      err.cause = e.code ?? e.message;
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearInterval(poll);
      if (stopPedido()) {
        resolve({ played: false, echo: null, truncated: true });
        return;
      }
      if (code === 0) {
        terminoLimpio = true;
        resolve({ played: true, echo: texto, truncated: false });
      } else {
        const err = new Error('tts_failed');
        err.code = 'tts_failed';
        err.cause = `exit ${code} signal ${signal}`;
        reject(err);
      }
    });

    // el texto viaja por stdin y se cierra: fin de entrada
    child.stdin.write(texto);
    child.stdin.end();
  });
}
