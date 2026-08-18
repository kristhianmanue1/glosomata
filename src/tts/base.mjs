// Motor base: spawn en grupo propio + kill del grupo + texto SIEMPRE por
// stdin (argv visible en ps — política REQ-6, ADR-005).

import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

export async function reproducirSubprocess(cfg, argv, texto) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(argv[0], argv.slice(1));
    let poll;
    child.on('error', (e) => {
      clearInterval(poll);
      reject(Object.assign(new Error('tts_failed'), { code: 'tts_failed', cause: e.code ?? e.message }));
    });
    child.on('close', (code) => {
      clearInterval(poll);
      if (stopPedido()) return resolve({ played: false, echo: null, truncated: true });
      if (code === 0) resolve({ played: true, echo: texto, truncated: false });
      else {
        reject(Object.assign(new Error('tts_failed'), { code: 'tts_failed', cause: `exit ${code}` }));
      }
    });
    poll = setInterval(() => {
      if (stopPedido()) {
        clearInterval(poll);
        matarGrupo(child);
        resolve({ played: false, echo: null, truncated: true });
      }
    }, 50);
    child.stdin.write(texto);
    child.stdin.end();
  });
}
