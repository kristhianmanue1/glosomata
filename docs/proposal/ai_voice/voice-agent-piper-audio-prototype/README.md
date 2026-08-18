# Voice Agent Piper Audio Prototype

Prototipo paralelo y local para una Mac Apple Silicon. No modifica ni reemplaza
`../voice-agent-prototype`.

```text
Micrófono (WAV) -> Whisper.cpp -> Ollama -> Piper -> WAV -> altavoz
```

No introduzca datos personales, clínicos o de salud. La app no conserva audio,
texto ni conversaciones: cada archivo de entrada/salida se crea en un temporal
por solicitud y se elimina al terminar.

## Requisitos

- Node.js 20+ y Ollama con `qwen3:8b`.
- `whisper.cpp` y un modelo multilingüe `small`, por ejemplo
  `models/ggml-small.bin`.
- Python 3.12 con `piper-tts`.
- Voz `es_MX-claude-high` descargada en `models/`.
- Navegador con `getUserMedia`, `AudioContext` y permiso de micrófono.

La voz predeterminada es `es_MX-claude-high`, español mexicano, sin ajuste de
tono (escala `1.00`).
Piper está bajo GPL-3.0: este experimento local no autoriza distribución.

## Configuración local

El servidor sólo escucha en `127.0.0.1`. Ajuste rutas mediante variables de
entorno, sin poner secretos en la página:

```bash
WHISPER_BIN=/ruta/a/whisper-cli \
WHISPER_MODEL=/ruta/a/ggml-small.bin \
KOKORO_PYTHON=/ruta/a/.venv/bin/python \
npm start
```

`KOKORO_VOICE=em_santa` cambia la voz. `OLLAMA_MODEL` y `OLLAMA_BASE_URL`
conservan el contrato de la versión base.

`KOKORO_PITCH_SCALE=1.0` desactiva el ajuste tonal; el rango aceptado es de
0.8 a 1.2. El ajuste requiere FFmpeg local.

## Ejecutar y probar

```bash
npm test
npm run start:local
```

Abra <http://localhost:8080>. Para un turno por voz, pulse **Grabar mensaje**,
hable y pulse **Finalizar grabación**. Si los motores de audio no están
instalados, escriba el mensaje: Ollama sigue pudiendo responder, y la interfaz
explicará el motor local que falta.

## Endpoints locales

- `POST /api/transcribe`: recibe sólo `audio/wav` de hasta 8 MB y entrega texto.
- `POST /api/respond`: recibe/entrega JSON y usa el adaptador Ollama.
- `POST /api/synthesize`: recibe texto y entrega `audio/wav` de Kokoro.

No hay endpoints expuestos a la red ni autenticación de terceros.

## Verificación física pendiente

Las pruebas automatizadas no prueban micrófono, altavoz ni latencia. Antes de
adoptar esta versión se debe verificar en la M2, Safari y Chrome: permiso,
dos turnos, cancelación, ruido moderado, texto visible y fin de reproducción.

## Plan

El diseño y criterios de aceptación están en
[el plan local Whisper/Kokoro](docs/kokoro-whisper-local-plan.md).
