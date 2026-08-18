// Plantillas v1 — catálogo base, validación RE2-style + NFC, echo-back.
// Contrato: docs/specs/contrato-plantilla.md
// v1 EXCLUYE expectation intent-free → not_supported (ADR-003/round-2).

export const CATALOGO = {
  confirmar: {
    id: 'confirmar',
    kind: 'structured',
    proposed_by: 'builtin',
    description: 'Confirmación sí/no del orquestador',
    turns: [{ expectation: 'exact', pattern: 'sí|no|si' }],
  },
  informar: {
    id: 'informar',
    kind: 'structured',
    proposed_by: 'builtin',
    description: 'Reporte de un hecho; espera acuse',
    turns: [{ expectation: 'exact', pattern: 'recibido|ok|enterado' }],
  },
  preguntar: {
    id: 'preguntar',
    kind: 'structured',
    proposed_by: 'builtin',
    description: 'Pregunta cerrada con opciones declaradas en pattern',
    turns: [{ expectation: 'exact', pattern: '[a-z0-9 ]{1,40}' }],
  },
  libre: {
    id: 'libre',
    kind: 'free',
    proposed_by: 'builtin',
    description: 'Modo libre: sin validación',
    turns: [],
  },
};

// Canonización: NFC → strip inaudibles → límite (docs/specs/contrato-plantilla.md)
const INAUDIBLES =
  /[\u200B-\u200D\uFEFF\u202A-\u202E\u0000-\u0008\u000B-\u001F]/g;

export function canonizar(texto, maxChars = 2000) {
  const nfc = texto.normalize('NFC').replace(INAUDIBLES, '');
  if (nfc.length > maxChars) {
    const err = new Error('text_too_long');
    err.code = 'text_too_long';
    throw err;
  }
  return nfc;
}

const CLAVES_TURNO = new Set(['expectation', 'pattern', 'objections']);
const CLAVES_PLANTILLA = new Set(
  ['id', 'kind', 'proposed_by', 'description', 'turns']
);

// Validación de plantilla cerrada (schema) — rechaza lo no declarado.
export function validarPlantilla(t) {
  const err = new Error('template_invalid');
  err.code = 'template_invalid';
  if (!t || typeof t !== 'object') throw err;
  for (const k of Object.keys(t)) {
    if (!CLAVES_PLANTILLA.has(k)) throw err;
  }
  if (!/^[a-z0-9-]{1,64}$/.test(t.id ?? '')) throw err;
  if (!['free', 'structured'].includes(t.kind)) throw err;
  if (!['agent', 'orchestrator', 'builtin'].includes(t.proposed_by)) throw err;
  if (!Array.isArray(t.turns)) throw err;
  for (const turno of t.turns) {
    if (!turno || typeof turno !== 'object') throw err;
    for (const k of Object.keys(turno)) {
      if (!CLAVES_TURNO.has(k)) throw err;
    }
    if (turno.expectation === 'intent-free') {
      const ns = new Error('not_supported');
      ns.code = 'not_supported';
      ns.detalle = 'expectation intent-free excluida de v1';
      throw ns;
    }
    if (!['exact', 'regex'].includes(turno.expectation)) throw err;
    if (turno.expectation === 'regex') {
      if (typeof turno.pattern !== 'string' || turno.pattern.length > 200) throw err;
    }
    if (turno.objections !== undefined) {
      if (
        !Array.isArray(turno.objections) ||
        turno.objections.some((o) => typeof o !== 'string' || o.length > 200)
      ) {
        throw err;
      }
    }
  }
  return true;
}

// RE2-style: prohíbe constructos de retroceso catastrófico y captura peligrosa.
// Dialecto v1: subconjunto lineal de JS RegExp sin backreferences,
// lookaround, ni cuantificadores anidados sobre grupos (grupo con cuantificador
// dentro, cuantificado otra vez por fuera), ni cuantificador abierto {n,}.
function patronPeligroso(pattern) {
  if (/\\[1-9]|\(\?[<=!]|\{\s*\d*\s*,\s*\}/.test(pattern)) return true;
  if (/[*+]\s*[*+]/.test(pattern)) return true;
  // cuantificador tras un grupo cuyo contenido contiene otro cuantificador
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === ')') {
      let j = i - 1;
      if (pattern[j] === undefined) return true;
      if (!' *+?{}'.includes(pattern[j])) continue;
      // abre el grupo hacia atrás y mira si dentro hay cuantificador
      let prof = 0;
      for (let k = i - 1; k >= 0; k--) {
        if (pattern[k] === ')') prof++;
        else if (pattern[k] === '(') {
          if (prof === 0) {
            const interior = pattern.slice(k + 1, i - ('?'.includes(pattern[i-1]) ? 1 : 0));
            if (/[*+?{}]/.test(interior)) return true;
          }
          prof--;
        }
      }
    }
  }
  return false;
}

export function regexSegura(pattern) {
  if (patronPeligroso(pattern)) {
    const err = new Error('template_invalid');
    err.code = 'template_invalid';
    err.detalle = 'patrón usa constructo fuera del dialecto v1';
    throw err;
  }
  return new RegExp(`^(?:${pattern})$`, 'i');
}

// Validación de turno — función pura (plantilla, turno, texto) → resultado.
export function validarTurno(plantilla, turn, textoCrudo, maxChars = 2000) {
  validarPlantilla(plantilla);
  if (!Number.isInteger(turn) || turn < 0) {
    const err = new Error('session_invalid');
    err.code = 'session_invalid';
    throw err;
  }
  const texto = canonizar(textoCrudo, maxChars);
  if (plantilla.kind === 'free' || plantilla.turns.length === 0) {
    return { result: 'ok', next_turn: turn + 1 };
  }
  const spec = plantilla.turns[Math.min(turn, plantilla.turns.length - 1)];
  if (spec.expectation === 'exact') {
    const re = regexSegura(spec.pattern);
    return re.test(texto)
      ? { result: 'ok', next_turn: turn + 1 }
      : { result: 'fail', expected: spec.pattern, next_turn: turn };
  }
  const re = regexSegura(spec.pattern);
  return re.test(texto)
    ? { result: 'ok', next_turn: turn + 1 }
    : { result: 'fail', expected: spec.pattern, next_turn: turn };
}

export function validarObjecion(plantilla, turn, texto) {
  const spec = plantilla.turns[Math.min(turn, plantilla.turns.length - 1)];
  const obj = spec?.objections?.find((o) => texto.includes(canonizar(o)));
  return obj ? { result: 'objection', objection: obj, next_turn: turn } : null;
}

export async function templates(argv) {
  const showIdx = argv.indexOf('--show');
  if (showIdx >= 0) {
    const id = argv[showIdx + 1];
    if (!/^[a-z0-9-]{1,64}$/.test(id ?? '')) {
      const err = new Error('template_invalid');
      err.code = 'template_invalid';
      throw err;
    }
    const t = CATALOGO[id];
    if (!t) {
      const err = new Error('not_found');
      err.code = 'not_found';
      throw err;
    }
    process.stdout.write(`${JSON.stringify(t, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(
    `${JSON.stringify(Object.values(CATALOGO).map(({ turns, ...t }) => t), null, 2)}\n`
  );
  return 0;
}

export async function validate(argv) {
  const sIdx = argv.indexOf('--session');
  const tIdx = argv.indexOf('--text');
  if (sIdx < 0 || tIdx < 0) {
    const err = new Error('usage: validate requiere --session y --text');
    err.code = 'usage';
    throw err;
  }
  const { readFile } = await import('node:fs/promises');
  const ses = JSON.parse(await readFile(argv[sIdx + 1], 'utf8'));
  const out = validarTurno(ses.template, ses.turn ?? 0, argv[tIdx + 1]);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return out.result === 'ok' ? 0 : 1;
}
