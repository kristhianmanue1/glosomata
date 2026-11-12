// Motor de diarización (D1, ADR-012): probe ESTRUCTURAL, sin ejecutar
// nada. La operación `diarize` (CLI) llega en D2; este módulo es la
// casa natural del diagnóstico, como diagnosticoWhisper lo es del STT.
// Contrato: docs/specs/contrato-diarizacion-v1.md §6-§7.

import { access, constants, stat } from 'node:fs/promises';
import { join } from 'node:path';

// engines.diar ausente → null (NO declarado: no es defecto, la
// superficie responde not_supported). Declarado → {ok, causa?} con el
// conjunto cerrado del contrato §7: python_ausente |
// script_ausente | pesos_ausentes | probe_fallido.
//
// `pipeline` es el espejo LOCAL de pyannote
// speaker-diarization-community-1: un DIRECTORIO con config.yaml (la
// firma estructural mínima que Pipeline.from_pretrained exige para
// cargar sin red — ADR-012: glosomata jamás descarga pesos). El
// python apunta al venv SEPARADO (torch/torchcodec no intoxican el
// venv de kokoro/piper). Rutas relativas contra el CWD del proceso
// (regla transversal de la guía). Sin base para especular causas más
// finas: el chequeo es de existencia/estructura, no de ejecución.
export async function diagnosticoDiar(cfg) {
  const d = cfg?.engines?.diar;
  if (d === undefined) return null;
  const forma = (v) => typeof v === 'string' && v.length > 0;
  // config editada a mano (sin schema de por medio): fail-closed sin
  // atribuir 'ausente' a lo que ni forma tiene
  if (d === null || typeof d !== 'object'
      || !forma(d.python) || !forma(d.script) || !forma(d.pipeline)) {
    return { ok: false, causa: 'probe_fallido' };
  }
  try {
    await access(d.python, constants.F_OK);
  } catch {
    return { ok: false, causa: 'python_ausente' };
  }
  try {
    await access(d.script, constants.F_OK);
  } catch {
    return { ok: false, causa: 'script_ausente' };
  }
  try {
    const st = await stat(d.pipeline);
    if (!st.isDirectory()) return { ok: false, causa: 'pesos_ausentes' };
    await access(join(d.pipeline, 'config.yaml'), constants.F_OK);
  } catch {
    return { ok: false, causa: 'pesos_ausentes' };
  }
  return { ok: true };
}
