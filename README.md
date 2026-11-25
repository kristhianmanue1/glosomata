# glosomata

Canal de voz **100% local** entre agentes de IA y su orquestador humano.
Voz→texto (whisper.cpp / servicio STT turbo para tequio), texto→voz
(Kokoro MLX / Piper / say / Phonon experimental / LFM3-Omni
experimental), **diarización de hablantes** (pyannote
community-1, huellas de voz opcionales) y un contrato de comunicación
por turno: libre o por plantilla. Se consume como **CLI** o como
**servidor MCP (stdio)**. Sin navegador ni APIs externas. El adaptador
experimental Phonon consulta por loopback al Ollama local (ADR-010).

Del griego γλώσσα (*glṓssa*, "lengua"): el órgano del habla, el canal —
no el cerebro que decide qué decir.

## Qué es y qué no es

**Es:** el canal de voz. STT, TTS, contrato de turnos y plantillas.

**No es:** el agente. El LLM vive en el consumidor (CLI/MCP); Ollama sólo
se usa para TTS en el adaptador experimental y como demo en
`docs/proposal/`. Ninguna garantía de seguridad depende de la sesión: sus contadores
son metadata consultiva del agente.

## Requisitos

- Node.js ≥ 20 (verificado con v24).
- `whisper.cpp` compilado con modelo `ggml-small.bin`
  (ej. en `~/.local-models/whisper.cpp/`).
- Para la **diarización**: `engines.diar` en la matriz (python del venv
  separado `.venv-diar` con pyannote.audio 4.x, espejo local del
  pipeline speaker-diarization-community-1; ADR-012,
  `docs/specs/contrato-diarizacion-v1.md`).
- Al menos un motor TTS disponible:
  - `say` (macOS, sin instalación);
  - Piper (binario externo; GPL-3.0 — subprocess con texto por stdin,
    nunca link ni bundle: ADR-005);
  - Kokoro MLX (Apple Silicon, Python).
  - Phonon mediante Ollama local (experimental, macOS Apple Silicon;
    configuración y límites en `docs/phonon-ollama-experimental.md`).
  - LFM3-Omni vía gateway local 8092 (experimental, macOS; voz fija
    `es`, 1..600 caracteres; ADR-011, `docs/lfm3-omni-tts.md`).

## Comandos (contrato CLI v1)

```bash
node src/cli.mjs speak --text "listo"
node src/cli.mjs listen --timeout 10
node src/cli.mjs diarize --file audio.wav
node src/cli.mjs diarize --file audio.wav --embeddings
node src/cli.mjs diarize --file audio.wav --min-speakers 2 --max-speakers 4
node src/cli.mjs stop
node src/cli.mjs engines
node src/cli.mjs devices
node src/cli.mjs version
node src/cli.mjs doctor
node src/cli.mjs templates --list
node src/cli.mjs session new --template confirmar
node src/cli.mjs validate --session ses.json --text "sí"
node src/cli.mjs config list
node src/cli.mjs config get engines
node src/cli.mjs config validate
node src/cli.mjs config set nueva-config.json
```

Servidor MCP (stdio):

```bash
npm run mcp
```

Guía de consumo (registro en clientes, tools, códigos de error):
`docs/guia-mcp.md`.

## Configuración

`glosomata.json` (ver `glosomata.example.json`): matriz de motores con
disponibilidad y selección, rutas de whisper, restricciones (kill-switch por
motor, piso de validación, canales de confirmación).

Variables de entorno (contrato en `docs/guia-mcp.md`): `GLOSOMATA_CONFIG`
(ruta alternativa de la matriz), `GLOSOMATA_RUNTIME` (directorio de
lock/temporales) y `GLOSOMATA_FFMPEG` (binario de captura STT).

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
  cli-core.mjs   # despacho de comandos y exit codes
  mcp.mjs        # servidor MCP stdio (contrato MCP v1)
  mcp-core.mjs   # protocolo JSON-RPC y tools
  canal.mjs      # half-duplex, lockfile, temporales, kill-switch
  ops.mjs        # operaciones: retornan {code, data}
  matriz.mjs     # carga y validación de glosomata.json (ADR-008)
  schema.mjs     # validador JSON Schema draft-07 (subconjunto)
  error-codes.mjs # taxonomía cerrada de códigos
  duration.mjs   # duration_ms wall-clock de las operaciones
  devices.mjs    # inventario de audio del host (contrato-hardware)
  tts/           # adaptadores EngineTTS: say, piper, kokoro, phonon_ollama, lfm3
  stt.mjs        # whisper.cpp (subprocess, 16 kHz mono PCM)
  diar.mjs       # operación diarize (contrato-diarizacion-v1)
  diar/          # script Python del motor pyannote
  plantillas.mjs # catálogo base + validación RE2-style + NFC
  sesion.mjs     # sesión efímera (metadata consultiva del agente)
services/
  stt-turbo/     # artefacto de despliegue del servicio STT turbo
                 # (ADR-014: Malintzin lo despliega en el Dell;
                 # muerto para el núcleo, no se ejecuta ni instala)
tests/           # node --test
docs/
  adr/           # ADR-001..014
  specs/         # contratos v1 (specs, consumo, diarización, hardware)
requirements/
  diar-linux-cuda.lock # lock del venv de diarización para el Dell
```

## Límites de tamaño

Hereda los del estándar Skevi (800 líneas por archivo de texto; 200
AGENTS.md; 300 README/plantillas). Verificación: `python3
scripts/check_sizes.py` (copiado de Skevi, configurable con
`skevi-gate.json`).

## Estado

F0–F3 cerradas (v0.1.0-alpha.2). Desde entonces: consumo de agentes,
configuración gobernada (ADR-008), inventario y selección de
dispositivos (contrato-hardware), VAD de fin de turno (ADR-013),
**diarización completa** (ADR-012: contrato v1.7 NORMATIVO con
huellas de voz opcionales, dispositivo de cómputo, hints de rango;
ensayo vivo D3 verificado), **servicio STT turbo** (ADR-014:
artefacto `services/stt-turbo` para el Dell, con lock del build) y
AN-KLA beta.43 (plugin OpenCode). Historia de decisión en
`docs/adr/`.

## Licencia

Apache-2.0 (`LICENSE`). Los binarios y modelos que glosomata invoca por
subprocess conservan sus propias licencias (Piper es GPL-3.0; ver
ADR-005 para la frontera). El checkpoint Phonon español declara
CC BY-NC 4.0; ver ADR-010. Los pesos de pyannote
speaker-diarization-community-1 son CC-BY-4.0 (ADR-012); los pesos
de Whisper large-v3-turbo (q8_0) son MIT (ADR-014).
