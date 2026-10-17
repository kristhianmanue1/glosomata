// Adaptador say (macOS) — subprocess en grupo, texto por stdin.
// `say` lee de stdin con `-f -`.

import { access, constants } from 'node:fs/promises';
import { reproducirSubprocess } from './base.mjs';

// probe honesto (ronda 5, L-1): plataforma Y binario real.
// Diagnóstico cerrado (doctor, C0.2): causas en conjunto cerrado.
export async function diagnostico() {
  if (process.platform !== 'darwin') {
    return { ok: false, causa: 'plataforma_no_soportada' };
  }
  try {
    await access('/usr/bin/say', constants.F_OK);
    return { ok: true };
  } catch {
    return { ok: false, causa: 'binario_ausente' };
  }
}

export async function disponible() {
  return (await diagnostico()).ok;
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
