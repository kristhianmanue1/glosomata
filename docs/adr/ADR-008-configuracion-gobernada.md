# ADR-008: configuración gobernada de `glosomata.json`

Estado: PROPUESTA — pendiente de aceptación del humano
Fecha: 2026-10-17 (v2 del mismo día: el playground/web pasa a
proyecto aparte por decisión del operador; esta versión NO reabre
ningún no-objetivo)
Numeración: 006 y 007 quedan reservados por el plan de consumo
(docs/plan-consumo-agentes-v1.md, tareas C3.1 y C3.3).

## Contexto

La configuración (`glosomata.json`) hoy se edita a mano: sin schema
formal, sin validación previa, sin copia de seguridad, y fuera del
alcance de los consumidores (los 7 tools MCP no tocan config; el CLI
tampoco). El operador pidió gestionarla por comandos consumibles por
agentes (CLI/MCP).

La primera versión de este ADR (mismo día) proponía reabrir el
no-objetivo HTTP con un servidor de loopback dentro de glosomata para
un playground web. El operador decidió que el playground y su página
vivirán en un PROYECTO APARTE que consume glosomata por sus
superficies contratadas (CLI/MCP). Eso elimina la razón de ser de la
reapertura HTTP: el rechazo original a «proyecto aparte» asumía que
éste importaría `ops.mjs` o duplicaría la capa de operaciones — con
consumo contractual no hay duplicación ni superficie nueva.

## Decisión

1. **La escritura de configuración pasa a ser gobernada**: schema JSON
   formal de `glosomata.json` (tarea P0.2 del plan), validación
   completa (estructura + probes + kill_switch) ANTES de guardar,
   escritura atómica (temporal 0600 + rename) y copia de seguridad
   previa fuera del árbol versionado, retención por conteo (últimas
   5). El contenido persistido nunca incluye campos derivados de
   runtime (`available`, `causa`).
2. **Nuevas superficies de configuración**: comandos CLI
   `config list|get|set|validate` (P1) y tool MCP `get_config`
   SANEADA — disponibilidad sin rutas del filesystem (curación de
   ronda 5 intacta; P2). La config COMPLETA (con rutas) es canal del
   operador —CLI o el futuro proyecto externo autenticado—, nunca
   MCP.
3. **El no-objetivo HTTP queda INTACTO**: glosomata no abre servidor
   HTTP/socket ni navegador. El playground web (serve/UI/selftest,
   antes P3–P5 del plan) migra a un proyecto aparte cuyo hogar decide
   el operador; su frontera, token y modelo de amenazas le pertenecen
   y se documentan allá. glosomata sólo garantiza lo que su contrato
   ya declara.

## Alternativas descartadas

- **Servidor HTTP de loopback dentro de glosomata** (propuesta
  original de este ADR): reabría un no-objetivo v1 declarado y metía
  la evolución riesgosa (publicación, multiusuario, TLS) dentro del
  núcleo. El consumo contractual del proyecto aparte ofrece lo mismo
  sin tocar la promesa. El modelo de amenazas loopback escrito para
  esa versión (Bearer CSPRNG por stdout, allowlist de Host, excepción
  consciente de assets) se recicla como semilla del proyecto nuevo.
- **El proyecto aparte edita `glosomata.json` por sí mismo**:
  duplicaría validación/atomicidad/backup — o los perdería. Es la
  justificación de que `config set` exista DENTRO y el playground lo
  consuma.
- **Exportar una librería Node (`ops.mjs`) para el playground**:
  superficie no contratada (contrato §1); sigue reservada (ADR-007,
  plan de consumo C3.3).
- **Framework web dentro de glosomata**: viola la regla de cero
  dependencias; en el proyecto nuevo esa regla no aplica y puede
  elegir libremente.

## Consecuencias

- La taxonomía crece con `config_write_failed`, documentada a más
  tardar en el commit que la emita (regla: sólo crece).
- El plan `plan-playground-config-v1` reduce su alcance a P0–P2
  (fundamentos y config por CLI/MCP); P3–P5 quedan marcadas como
  migradas al proyecto externo, pendientes de hogar.
- Ningún documento canónico cambia sus no-objetivos: siguen siendo
  verdad literal. README, SECURITY, guía y spec no se tocan.
- El proyecto externo depende sólo de superficies contratadas: si
  consume algo no contratado, es bug suyo — o señal de que falta
  superficie, lo que se decide por ADR, no por import.
