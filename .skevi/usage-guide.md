# Uso de Skevi en este proyecto

**Proyecto:** glosomata
**Fase actual:** F3 cerrada (v0.1.0-alpha.2; motores TTS/STT reales,
ronda adversarial 4 cerrada — ver `.skevi/architecture-overview.md`)
**Fuente del método:** skevi (repo hermano en el ecosistema aria)

## Qué leer primero

1. `AGENTS.md` en la raíz — punto de entrada, trae el bloque de registro
   que enlaza a este archivo.
2. `docs/ai-agent-guide/00-INDICE.md` — fases F0→F3 y reglas de aplicación.
3. `docs/estandar-diseno-software-github.md` — capa normativa transversal.

## Desviaciones de este proyecto respecto al estándar por defecto

- `skevi-gate.json` excluye del recorrido `docs/proposal/` (prototipos web
  previos, 1.3G con .venv y binarios: evidencia histórica de F0, no código
  del proyecto) y `.local-models/` (whisper.cpp compilado, 542M).
- El proyecto hereda los límites de tamaño por defecto del estándar.
- Deuda heredada del template: `docs/ai-agent-guide/00-INDICE.md` cita como
  procedencia `docs/history/piloto-skopos.md` y
  `../adr/ADR-005-resultado-por-linea-de-evidencia.md`, que viven en el repo
  skevi fuente, no aquí. Se anotan, no se corrigen: no le toca a este repo
  reescribir la guía del método.

## Verificación local

```bash
python3 scripts/check_sizes.py
npm test
```

## Dónde están los ADRs y specs de F1

- `docs/adr/ADR-001..005` — stateless/sesión, adaptadores, Ollama fuera,
  CAGF traducido, frontera GPL Piper.
- `docs/specs/specs-y-contratos-v1.md` — SPEC-1/2 + contratos CLI, MCP,
  plantilla, sesión, matriz + máquina de estados + no objetivos v1.
