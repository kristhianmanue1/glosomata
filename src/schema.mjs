// Validador mínimo de JSON Schema (draft-07, subconjunto).
// El repo es cero-dependencias: no hay ajv. El schema de config usa
// SOLO estas palabras clave — si el schema crece a otra, este
// validador debe crecer con ella (tests/schema.test.mjs lo vigila).
// Runtime (P1.3/P1.2): `config validate`/`config set` validan la
// ESTRUCTURA con esto; los probes y kill_switch siguen en matriz.mjs.

export function validar(instancia, schema, raiz = schema, ruta = '$') {
  const errores = [];
  const anota = (m) => errores.push(`${ruta}: ${m}`);

  // Schemas booleanos (draft-07): true acepta todo, false rechaza todo
  // (ronda adversarial: antes se ignoraban en silencio)
  if (schema === true) return errores;
  if (schema === false) {
    anota('schema false: nada es válido aquí');
    return errores;
  }

  // $ref local a definitions (única forma que el schema usa)
  if (schema.$ref) {
    const m = /^#\/definitions\/([a-zA-Z0-9_-]+)$/.exec(schema.$ref);
    if (!m || !raiz.definitions?.[m[1]]) {
      anota(`$ref no soportado o roto: ${schema.$ref}`);
      return errores;
    }
    return validar(instancia, raiz.definitions[m[1]], raiz, ruta);
  }

  // enum
  if (schema.enum && !schema.enum.some((v) => igual(instancia, v))) {
    anota(`fuera de enum ${JSON.stringify(schema.enum)}`);
  }

  // type (integer = number sin parte fraccional, como draft-07)
  if (schema.type) {
    const tipos = Array.isArray(schema.type) ? schema.type : [schema.type];
    const okTipo = tipos.some((t) => esDeTipo(instancia, t));
    if (!okTipo) anota(`esperaba ${tipos.join('|')}, llegó ${nombreTipo(instancia)}`);
  }

  // numéricos
  if (typeof instancia === 'number' && Number.isFinite(instancia)) {
    if (schema.minimum !== undefined && instancia < schema.minimum) {
      anota(`${instancia} < minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && instancia > schema.maximum) {
      anota(`${instancia} > maximum ${schema.maximum}`);
    }
    if (schema.exclusiveMinimum !== undefined
        && instancia <= schema.exclusiveMinimum) {
      anota(`${instancia} <= exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
  }

  // strings
  if (typeof instancia === 'string') {
    if (schema.minLength !== undefined && instancia.length < schema.minLength) {
      anota(`largo ${instancia.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && instancia.length > schema.maxLength) {
      anota(`largo ${instancia.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(instancia)) {
      anota(`no matchea ${schema.pattern}`);
    }
  }

  // arrays
  if (Array.isArray(instancia)) {
    if (schema.minItems !== undefined && instancia.length < schema.minItems) {
      anota(`items ${instancia.length} < minItems ${schema.minItems}`);
    }
    if (Array.isArray(schema.items)) {
      // forma tupla NO soportada por este subconjunto: fallar cerrado y
      // ruidoso, jamás validar en silencio (ronda adversarial, hallazgo 2)
      anota('items en forma tupla no está soportado por el validador');
    } else if (schema.items) {
      instancia.forEach((item, i) => {
        errores.push(...validar(item, schema.items, raiz, `${ruta}[${i}]`));
      });
    }
  }

  // objetos
  if (instancia !== null && typeof instancia === 'object' && !Array.isArray(instancia)) {
    for (const k of schema.required ?? []) {
      if (!(k in instancia)) anota(`falta requerida '${k}'`);
    }
    if (schema.properties) {
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in instancia) {
          errores.push(...validar(instancia[k], sub, raiz, `${ruta}.${k}`));
        }
      }
    }
    if (schema.additionalProperties === false) {
      const permitidas = new Set(Object.keys(schema.properties ?? {}));
      for (const k of Object.keys(instancia)) {
        if (!permitidas.has(k)) anota(`clave adicional '${k}' no permitida`);
      }
    } else if (schema.additionalProperties) {
      const permitidas = new Set(Object.keys(schema.properties ?? {}));
      for (const [k, v] of Object.entries(instancia)) {
        if (!permitidas.has(k)) {
          errores.push(...validar(v, schema.additionalProperties, raiz, `${ruta}.${k}`));
        }
      }
    }
  }

  return errores;
}

function esDeTipo(v, t) {
  switch (t) {
    case 'object': return v !== null && typeof v === 'object' && !Array.isArray(v);
    case 'array': return Array.isArray(v);
    case 'string': return typeof v === 'string';
    case 'boolean': return typeof v === 'boolean';
    case 'null': return v === null;
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer':
      return typeof v === 'number' && Number.isFinite(v)
        && Math.trunc(v) === v;
    default: return false; // tipo desconocido: fail-closed
  }
}

function nombreTipo(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function igual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
