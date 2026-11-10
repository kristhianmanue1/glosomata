# Uso de Skevi en este proyecto

**Proyecto:** glosomata
**Fase actual:** F3 cerrada (v0.1.0-alpha.2; motores TTS/STT reales,
ronda adversarial 4 cerrada — ver `.skevi/architecture-overview.md`)
**Fuente del método:** skevi (repo hermano en el ecosistema aria)
**Procedencia (ADR-031):** corpus/v8 + gate/v13 desde
`https://github.com/kristhianmanue1/skevi@f077769` (tag `v1.6.0`,
2026-10-29), instalado el 2026-11-10. Espejos con digests:
`.skevi/corpus-installed.json` y `.skevi/scripts-installed.json`.

## Qué leer primero

1. `AGENTS.md` en la raíz — punto de entrada, trae el bloque de registro
   que enlaza a este archivo.
2. `docs/ai-agent-guide/00-INDICE.md` — fases F0→F3 y reglas de aplicación.
3. `docs/estandar-diseno-software-github.md` — capa normativa transversal.

## Desviaciones de este proyecto respecto al estándar por defecto

- `skevi-gate.json` excluye del recorrido `docs/proposal/` (prototipos web
  previos, 1.3G con .venv y binarios: evidencia histórica de F0, no código
  del proyecto) y `.local-models/` (whisper.cpp compilado, 542M). En
  gate/v13 `skip_dirs` casa por partes del nombre (`proposal`,
  `.local-models`, …), no por prefijo de ruta; los `.DS_Store` se exentan
  por nombre con `exempt_names`, patrón canónico de skevi.
- El proyecto hereda los límites de tamaño por defecto del estándar.
- Deuda heredada del corpus (vigente también en corpus/v8):
  `docs/ai-agent-guide/00-INDICE.md` (líneas 47 y 97) cita como procedencia
  `docs/history/piloto-skopos.md` y
  `../adr/ADR-005-resultado-por-linea-de-evidencia.md`, que viven en el repo
  skevi fuente, no aquí. El patrón se repite en 01/02/04/05 y el estándar:
  ~7 enlaces markdown rotos (ADR-018, ADR-019, ADR-044, PROP-008) y ~10
  citas textuales a ficheros del repo fuente. Se anota, no se corrige: no
  le toca a este repo reescribir la guía del método.
- `required: []` en `skevi-gate.json` es elección previa del proyecto:
  reemplaza la lista canónica de skevi (que exigiría `templates/skevi/*`,
  MANIFEST y los cuatro scripts) y deja el gate sin archivos requeridos.
- Los espejos `.skevi/*-installed.json` son declarativos: fijan procedencia
  y digests, pero el gate no los re-verifica; la integridad se comprueba
  al instalar o actualizar la adopción.

## No adoptado aún (pendiente de decisión explícita)

- Kit de plantillas `templates/skevi/` (registro-contexto,
  plan-de-implementacion, frozen-trees) y su registro `installed.json`.
- Dominios `check_plans.py`, `check_reports.py` y `check_templates.py`:
  los cuatro scripts se copian como unidad (ADR-039) pero sólo
  `check_sizes.py` está cableado en la verificación local y CI.
- Claves `reading_path`, `reports` y `plans` del gate (presupuesto de
  lectura, informes en `docs/reviews/`).
- PROP-014 (contrato de coordinación multi-proyecto): política de skevi
  en piloto, sin peso normativo; no aplica a este repo por ahora.

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
