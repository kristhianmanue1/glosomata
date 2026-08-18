# ADR-002: motores TTS como adaptadores tras un contrato único

Estado: aceptado
Fecha: 2026-08-18
Fase: F1

## Contexto

REQ-2/REQ-4: motor TTS configurable según servicios disponibles. Los tres
prototipos previos (docs/proposal/) usan Kokoro MLX, Piper y say.

## Decisión

Un contrato EngineTTS; cada motor es un adaptador. La matriz
`glosomata.json` declara disponibilidad (probe real de binario/librería/SO)
y selección. Motor ausente → `engine_unavailable` declarado por motor, no
fallo global. STT: sólo whisper.cpp (todas las rutas ya lo usan).

## Alternativas descartadas

- Un motor único: pierde portabilidad (say es macOS-only; MLX exige Apple
  Silicon; Piper es GPL-3.0).

## Consecuencias

- Cada motor declara su kill-switch `{type, target, max_latency_ms}` en la
  matriz; el arranque valida la declaración (fail-closed si falta). La
  latencia es aserción del motor, validación de tipos solamente.
- Half-duplex cross-process: flock global en runtime dir per-user con
  política de staleness; CLI y MCP comparten el lock.
