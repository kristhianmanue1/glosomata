// Adaptador say (macOS) — subprocess en grupo, texto por stdin.
// `say` lee de stdin con `-f -`.

import { access, constants } from 'node:fs/promises';
import { reproducirSubprocess } from './base.mjs';

// probe honesto (ronda 5, L-1): plataforma Y binario real
export async function disponible() {
  if (process.platform !== 'darwin') return false;
  try {
    await access('/usr/bin/say', constants.F_OK);
    return true;
  } catch {
    return false;
  }
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
