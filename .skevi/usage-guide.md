# Uso de Skevi en este proyecto

**Proyecto:** glosomata
**Fase actual:** F2 (cascarón verificado; F3 pendiente)
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
