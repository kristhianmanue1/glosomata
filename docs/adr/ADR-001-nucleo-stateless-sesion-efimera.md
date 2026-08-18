# ADR-001: núcleo stateless con sesión efímera explícita

Estado: aceptado
Fecha: 2026-08-18
Fase: F1 (ronda adversarial 1 y 2)

## Contexto

glosomata se consume por CLI (proceso por invocación) y MCP (servidor stdio
de larga vida). La voz es bloqueante y REQ-6 prohíbe retener audio/texto.
MCP es request/response.

## Decisión

El núcleo no guarda estado entre invocaciones. La sesión es un artefacto
declarativo `{schema, id: uuid-v4, template, turn, created_at, ttl_min}` que
posee el agente y pasa por valor. La validación es función pura
`(plantilla, turno, texto) → {result, next_turn}`.

## Alternativas descartadas

- Stateless puro sin sesión: no permite plantillas multi-turno.
- Sesión persistente en servidor: viola REQ-6, ciclo de vida sin dueño,
  y la detección de conflicto reintroduce estado oculto (hallazgo BLOCKER
  ronda 2: "stateless pero detecta concurrencia" es contradictorio).

## Consecuencias

- El turno sólo avanza con `validate` sobre input humano (`listen`) con
  result ok; lo aplica el agente sobre su copia. `speak` jamás valida.
- La sesión es metadata consultiva: NINGÚN requisito de seguridad depende
  de turn, TTL ni contadores — son falseables por el agente que la posee.
  La confirmación con autoridad vive en el harness humano.
- Uso concurrente de una misma sesión: lockfile best-effort junto al
  archivo como aviso; no es garantía y no se declara como tal.
- Objection → mismo turno, reintento; máx 3 reintentos (contador del lado
  del agente) → `session_abandoned`.
