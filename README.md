# glosomata

Canal de voz **100% local** entre agentes de IA y su orquestador humano.
Voz→texto (whisper.cpp), texto→voz (Kokoro MLX / Piper / say), y un contrato
de comunicación por turno: libre o por plantilla. Se consume como **CLI** o
como **servidor MCP (stdio)**. Sin navegador, sin APIs de terceros, sin
retención de audio o texto.

Del griego γλώσσα (*glṓssa*, "lengua"): el órgano del habla, el canal —
no el cerebro que decide qué decir.

## Qué es y qué no es

**Es:** el canal de voz. STT, TTS, contrato de turnos y plantillas.

**No es:** el agente. El LLM vive en el consumidor (CLI/MCP); Ollama sólo
aparece como demo en `docs/proposal/` (prototipos web previos, no parte del
sistema). Ninguna garantía de seguridad depende de la sesión: sus contadores
son metadata consultiva del agente.

## Requisitos

- Node.js ≥ 20 (verificado con v24).
- `whisper.cpp` compilado con modelo `ggml-small.bin`
  (ej. en `~/.local-models/whisper.cpp/`).
- Al menos un motor TTS disponible:
  - `say` (macOS, sin instalación);
  - Piper (binario externo; GPL-3.0 — subprocess con texto por stdin,
    nunca link ni bundle: ADR-005);
  - Kokoro MLX (Apple Silicon, Python).

## Comandos (contrato CLI v1)

```bash
node src/cli.mjs speak --text "listo"
node src/cli.mjs listen --timeout 10
node src/cli.mjs stop
node src/cli.mjs engines
node src/cli.mjs templates --list
node src/cli.mjs session new --template confirm
node src/cli.mjs validate --session ses.json --text "sí"
```

Servidor MCP (stdio):

```bash
npm run mcp
```

## Configuración

`glosomata.json` (ver `glosomata.example.json`): matriz de motores con
disponibilidad y selección, rutas de whisper, restricciones (kill-switch por
motor, piso de validación, canales de confirmación).

## Construir, correr, probar

```bash
npm test        # suite node --test (unitarios de contratos)
npm start       # CLI (imprime ayuda)
npm run mcp     # servidor MCP stdio
```

Los tests unitarios no requieren micrófono ni motores: validan contratos,
plantillas, canonización y taxonomía de errores. La verificación física
(voz real, kill-switch, WER español) son gates de F3 documentados en
`docs/specs/`.

## Estructura

```text
src/
  cli.mjs        # entrada CLI (contrato CLI v1)
  mcp.mjs        # servidor MCP stdio (contrato MCP v1)
  canal.mjs      # half-duplex, lockfile, temporales, kill-switch
  tts/           # adaptadores EngineTTS: say, piper, kokoro
  stt.mjs        # whisper.cpp (subprocess, 16 kHz mono PCM)
  plantillas.mjs # catálogo base + validación RE2-style + NFC
  sesion.mjs     # sesión efímera (metadata consultiva del agente)
tests/           # node --test
docs/
  adr/           # ADR-001..005 (F1)
  specs/         # SPEC-1/2 + contratos v1 (F1)
```

## Límites de tamaño

Hereda los del estándar Skevi (800 líneas por archivo de texto; 200
AGENTS.md; 300 README/plantillas). Verificación: `python3
scripts/check_sizes.py` (copiado de Skevi, configurable con
`skevi-gate.json`).

## Estado

F0–F3 cerradas y mergeadas a main (v0.1.0-alpha.2): motores reales,
ronda adversarial de código cerrada — incluye el escáner regex
tokenizado (dialecto lineal, bypasses ReDoS reproducidos y cerrados).
Historia de decisión en `docs/adr/`.
