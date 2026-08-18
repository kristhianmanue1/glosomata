# Arquitectura propuesta — puntero

**Estado:** con ADRs (F1 cerrada 2026-08-18, tras dos rondas adversariales)

## ADRs del proyecto

- `docs/adr/ADR-001-nucleo-stateless-sesion-efimera.md` — núcleo sin
  estado; sesión efímera que posee el agente; validación como función pura.
- `docs/adr/ADR-002-motores-adaptadores.md` — TTS como adaptadores (Kokoro,
  Piper, say) tras un contrato; probe real de disponibilidad.
- `docs/adr/ADR-003-ollama-fuera-del-nucleo.md` — glosomata es canal puro;
  el LLM vive en el agente consumidor; intent-free excluida de v1.
- `docs/adr/ADR-004-axiomas-cagf-traducidos.md` — CAGF A0–A3 traducidos a
  requisitos operativos; A4+ fuera de alcance.
- `docs/adr/ADR-005-frontera-gpl-piper.md` — Piper sólo subprocess con
  texto por stdin; prohibido link y bundle.

Los contratos completos (CLI, MCP, plantilla, sesión, matriz) viven en
`docs/specs/specs-y-contratos-v1.md`.
