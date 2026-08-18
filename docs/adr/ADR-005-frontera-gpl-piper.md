# ADR-005: frontera GPL de Piper

Estado: aceptado
Fecha: 2026-08-18
Fase: F1 (ronda adversarial 2)

## Contexto

Piper es GPL-3.0; glosomata es Apache-2.0 (LICENSE del repo). Apache puede
ser consumido por GPL, no al revés: enlazar código Piper contamina.

## Decisión

El adaptador Piper ejecuta el binario como subprocess con argv sólo para
flags/modelo/rutas y **el texto viaja por stdin** (argv es visible en `ps`
para otros usuarios locales: equivalente a log de texto, prohibido por la
política de REQ-6). Queda prohibido link y bundling: la distribución de
glosomata no incluye binarios Piper ni modelos.

## Alternativas descartadas

- Descartar Piper: pierde la única voz es_MX de calidad sin Apple Silicon.
- Bundle con cumplimiento GPL: obliga a ofertar fuentes y complica toda
  la distribución por un motor opcional.

## Consecuencias

- `piper` en la matriz exige `bin` y `model` en rutas locales del usuario.
- Documentación declara que instalar Piper es responsabilidad del usuario.
