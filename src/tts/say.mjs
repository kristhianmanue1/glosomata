// Adaptador say (macOS) — subprocess en grupo, texto por stdin.
// `say` lee de stdin con `-f -`.

import { reproducirSubprocess } from './base.mjs';

export function disponible(cfg) {
  return process.platform === 'darwin';
}

export function argv(cfg) {
  const a = ['-f', '-'];
  if (cfg.voice) a.push('-v', cfg.voice);
  if (cfg.rate) a.push('-r', String(cfg.rate));
  return ['/usr/bin/say', ...a];
}

export async function hablar(cfg, texto) {
  return reproducirSubprocess(cfg, argv(cfg), texto);
}
