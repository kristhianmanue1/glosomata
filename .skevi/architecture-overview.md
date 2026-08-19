# Arquitectura — puntero

**Estado:** v0.1.0-alpha.2. F0–F3 cerradas. 4 rondas adversariales
acumuladas: 2 sobre specs de F1 (header de
`docs/specs/specs-y-contratos-v1.md`), rondas 3–4 sobre implementación
(comentarios en `canal.mjs`, `mcp-core.mjs`, `plantillas.mjs`, `stt.mjs`,
`ops.mjs`, `tts/piper.mjs`; commits `f1fe60f`, `5ad8e3d`).

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

## Mapa de módulos (runtime real, no propuesto)

| Módulo | Responsabilidad |
|---|---|
| `canal.mjs` | half-duplex: lockfile `O_EXCL`, temporales 0700, kill-switch cross-process por señal |
| `matriz.mjs` | carga `glosomata.json`, probes reales de disponibilidad, fail-closed sin `kill_switch` |
| `ops.mjs` | operaciones que retornan `{code, data}`; I/O de canal, jamás stdout |
| `cli.mjs`/`cli-core.mjs`, `mcp.mjs`/`mcp-core.mjs` | presentación: exit codes + stderr (CLI), JSON-RPC 2.0 por stdio (MCP) |
| `sesion.mjs` / `plantillas.mjs` | sesión efímera y validación de turno — funciones puras, TTL fail-closed |
| `stt.mjs` | whisper.cpp por subprocess, captura por plataforma (avfoundation/alsa) |
| `tts/{say,piper,kokoro}.mjs` | adaptadores tras contrato `EngineTTS` (ADR-002: `disponible()`/`hablar()`); sólo `say` usa el helper `tts/base.mjs` |

## Evidencia

- `npm test` → 42/42 (`tests/*.test.mjs`: CLI, MCP stdio, plantillas,
  sesión, STT por plataforma).
- `python3 scripts/check_sizes.py` → `OK`.
- Verificación física con los 3 motores TTS + STT real:
  `docs/hallazgos-2026-08-18-verificacion-cli-mcp.md`.
