// Plantillas v1 — catálogo base, validación RE2-style + NFC, echo-back.
// Contrato: docs/specs/contrato-plantilla.md. v1 EXCLUYE intent-free.

export const CATALOGO = {
  confirmar: {
    id: 'confirmar', kind: 'structured', proposed_by: 'builtin',
    description: 'Confirmación sí/no del orquestador',
    turns: [{ expectation: 'exact', pattern: 'sí|no|si' }],
  },
  informar: {
    id: 'informar', kind: 'structured', proposed_by: 'builtin',
    description: 'Reporte de un hecho; espera acuse',
    turns: [{ expectation: 'exact', pattern: 'recibido|ok|enterado' }],
  },
  preguntar: {
    id: 'preguntar', kind: 'structured', proposed_by: 'builtin',
    description: 'Pregunta cerrada con opciones declaradas en pattern',
    turns: [{ expectation: 'exact', pattern: '[a-záéíóúñ ]{1,40}' }],
  },
  libre: {
    id: 'libre', kind: 'free', proposed_by: 'builtin',
    description: 'Modo libre: sin validación',
    turns: [],
  },
};

// Canonización: NFC → strip inaudibles → límite
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
      throw ns;
    }
    if (!['exact', 'regex'].includes(turno.expectation)) throw err;
    if (typeof turno.pattern !== 'string' || turno.pattern.length === 0) throw err;
    if (turno.pattern.length > 200) throw err;
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

// Dialecto v1 (lineal): sin backreferences, lookaround, {n,} abierto,
// cuantificadores dobles, cuantificador sobre grupo con cuantificador
// dentro, NI alternancia bajo cuantificador de grupo (con *, +, ? o {n,m}:
// fuente de retroceso exponencial — hallazgo reproducido ronda 3).
// Tokenizador de una pasada: escapes y clases se respetan al parear
// grupos (el conteo hacia atrás sin tokenizar se cegaba con ')' en
// [...] o '\)' — bypass '[)x]|(xx)' reproducido: 2s con 40 chars), y
// ≥2 cuantificadores por rama fuera de clases se rechazan (cadenas tipo
// 'a*a*b' retroceden catastróficamente — ronda adversarial 4: 3s con
// 40 chars y 17 de patrón). Regla conservadora: sin análisis de
// solapamiento de átomos; la precisión fina es NFA de v2.
function patronPeligroso(pattern) {
  if (/\\[1-9]|\(\?[<=!]|\{\s*\d*\s*,\s*\}/.test(pattern)) return true;
  if (/[*+]\s*[*+]/.test(pattern)) return true;
  const pila = [];
  let enClase = false;
  let cuantif = 0;
  let ramaMax = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (enClase) {
      if (c === ']') enClase = false;
      continue;
    }
    if (c === '[') { enClase = true; continue; }
    if (c === '|') {
      if (pila.length === 0) {
        ramaMax = Math.max(ramaMax, cuantif);
        cuantif = 0;
      }
      continue;
    }
    if (c === '(') {
      pila.push(i);
      if (pattern[i + 1] === '?') i++; // '(?:…': sintaxis, no cuantificador
      continue;
    }
    if (c === ')') {
      const abre = pila.pop();
      if (abre === undefined) return true; // desbalanceado: fail-closed
      const q = pattern[i + 1];
      if (q === undefined || !'*+?{'.includes(q)) continue;
      if (interiorPeligroso(pattern, abre + 1, i)) return true;
      continue;
    }
    if (pila.length === 0 && '*+?{'.includes(c)) cuantif++;
  }
  if (pila.length > 0 || enClase) return true; // sin cerrar: fail-closed
  return Math.max(ramaMax, cuantif) >= 2;
}

// Interior de grupo cuantificado: '|' o cuantificador fuera de escapes
// y clases ('[?!]' o '\?' son literales seguros — ronda 4, MED-1).
function interiorPeligroso(pattern, desde, hasta) {
  let enClase = false;
  for (let i = desde; i < hasta; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; continue; }
    if (enClase) {
      if (c === ']') enClase = false;
      continue;
    }
    if (c === '[') { enClase = true; continue; }
    // '(?:' tras el abre del grupo: sintaxis, no cuantificador (LOW ronda 4:
    // sin exigir '(' previo se contrabandeaba un '?' real en '(a?:)*')
    if (c === '?' && pattern[i + 1] === ':' && pattern[i - 1] === '(') {
      i++;
      continue;
    }
    if (c === '|' || '*+?{'.includes(c)) return true;
  }
  return false;
}

export function regexSegura(pattern) {
  if (patronPeligroso(pattern)) {
    const err = new Error('template_invalid');
    err.code = 'template_invalid';
    throw err;
  }
  try {
    return new RegExp(`^(?:${pattern})$`, 'i');
  } catch {
    // el message de SyntaxError embebe el patrón: se descarta (política logs)
    const err = new Error('template_invalid');
    err.code = 'template_invalid';
    throw err;
  }
}

// Validación de turno — función pura. turn fuera de rango → session_invalid
// (antes: clamp que enmascaraba bugs del agente).
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
  if (turn > plantilla.turns.length - 1) {
    const err = new Error('session_invalid');
    err.code = 'session_invalid';
    throw err;
  }
  const spec = plantilla.turns[turn];
  const re = regexSegura(spec.pattern);
  return re.test(texto)
    ? { result: 'ok', next_turn: turn + 1 }
    : { result: 'fail', expected: spec.pattern, next_turn: turn };
}

export function validarObjecion(plantilla, turn, texto) {
  if (turn > plantilla.turns.length - 1) return null;
  const spec = plantilla.turns[turn];
  const obj = spec?.objections?.find((o) => texto.includes(canonizar(o)));
  return obj ? { result: 'objection', objection: obj, next_turn: turn } : null;
}

// —— datos (nunca imprimen) ——

export async function templatesData(argv) {
  const showIdx = argv.indexOf('--show');
  if (showIdx >= 0) {
    const id = argv[showIdx + 1];
    if (!/^[a-z0-9-]{1,64}$/.test(id ?? '')) {
      return { code: 1, data: { error: 'template_invalid' } };
    }
    const t = CATALOGO[id];
    if (!t) return { code: 1, data: { error: 'not_found' } };
    return { code: 0, data: t };
  }
  const lista = Object.values(CATALOGO).map(({ turns, ...t }) => t);
  return { code: 0, data: lista };
}

export async function validateData(argv) {
  const sIdx = argv.indexOf('--session');
  const tIdx = argv.indexOf('--text');
  if (sIdx < 0 || tIdx < 0) return { code: 2, data: { error: 'usage' } };
  const { readFile } = await import('node:fs/promises');
  let ses;
  try {
    ses = JSON.parse(await readFile(argv[sIdx + 1], 'utf8'));
  } catch {
    // el message embebe fragmentos del archivo: se descarta
    return { code: 1, data: { error: 'session_invalid' } };
  }
  const { expirada } = await import('./sesion.mjs');
  if (expirada(ses)) return { code: 1, data: { error: 'session_expired' } };
  try {
    const out = validarTurno(ses.template, ses.turn ?? 0, argv[tIdx + 1]);
    return { code: out.result === 'ok' ? 0 : 1, data: out };
  } catch (e) {
    return { code: 1, data: { error: e.code ?? 'internal_error' } };
  }
}
