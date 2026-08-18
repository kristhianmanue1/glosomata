# ADR-004: axiomas CAGF A0–A3 por traducción, no por copia

Estado: aceptado
Fecha: 2026-08-18
Fase: F1

## Contexto

REQ-9..12 derivan de los axiomas A0–A3 del framework CAGF
(repositorio externo `constitutional-ai-governance`, referencia —no
autoridad— de este proyecto). CAGF define: A0 kill-switch existencial,
A1 presupuesto de verificación, A2 decorrelación, A3 economía acotada.

## Decisión

Se traducen a requisitos operativos propios:

- A0 → REQ-9: kill-switch del canal por señal OS al proceso y su grupo;
  `stop` intra-proceso como cortesía (no operación de canal: flag atómico
  que el loop de playback poll-ea).
- A1 → REQ-10: `validation_floor_ms` con unidades y semántica declaradas.
- A2 → REQ-11: doble vía de confirmación (echo-back + validación).
- A3 → REQ-12: economía del turno — POSPUESTO a v2 por decisión humana;
  v1 es half-duplex sin cola, declarado no-objetivo.

## Alternativas descartadas

- Importar el formalismo CAGF completo: arrastra PolicyParameters y
  aparato de verificación que un canal de voz no justifica (mínimo
  necesario, regla 3 del índice Skevi).

## Consecuencias

- Cita de procedencia CAGF en cada REQ; A4+ excluidos del alcance.
- Fidelidad de la traducción verificada por lectura de CAGF-CORE.md y
  DEFINITIONS.md (evidencia en la sesión F0/F1 del orquestador).
