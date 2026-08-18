# Arquitectura del sistema

## Propósito

`voice-agent-prototype` valida una conversación local por voz: una persona
habla o escribe, el modelo devuelve texto y el navegador reproduce ese texto.
Es un prototipo técnico independiente. No pertenece a Alubia, no almacena
conversaciones ni audio y no debe recibir información personal, clínica o
sensible.

## Límites del sistema

```text
Persona
  │ habla o escribe
  ▼
Navegador ── POST /api/respond ──► Servidor Node ──► Adaptador de agente
  ▲                                      │                 │
  └──── speechSynthesis ◄────────────────┴──── texto ◄─────┘
```

El navegador conoce sólo `/api/respond`; no conoce el modelo, una clave ni la
URL de Ollama. El servidor selecciona el adaptador. En la configuración actual,
el adaptador usa Ollama local y `qwen3:8b`.

## Componentes

| Componente | Archivo | Responsabilidad |
|---|---|---|
| Interfaz y coordinación de turnos | `public/app.js` | Captura voz, envía texto, muestra respuesta, usa TTS y controla continuidad. |
| Documento y controles | `public/index.html` | Expone textarea, botones, estado accesible y respuesta visible. |
| Servidor HTTP | `src/server.mjs` | Sirve archivos estáticos y valida/atiende `POST /api/respond`. |
| Adaptadores de agente | `src/agents.mjs` | Define agente demo, Ollama y selección por variables de entorno. |
| Pruebas | `test/*.test.mjs` | Prueban validación, adaptadores, servidor y errores. |

## Ejecución

```bash
npm start
```

El proceso escucha sólo en `127.0.0.1:8080`. Requiere que Ollama esté activo
en `127.0.0.1:11434` y que el modelo seleccionado esté instalado.

Variables admitidas:

| Variable | Predeterminado | Uso |
|---|---|---|
| `AGENT_PROVIDER` | `ollama` | `ollama` o `demo`. Otros valores fallan cerrado. |
| `OLLAMA_MODEL` | `qwen3:8b` | Modelo local usado por el adaptador. |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Dirección del servicio Ollama. |
| `PORT` | `8080` | Puerto local del prototipo. |

`npm run start:demo` evita por completo Ollama y usa el respondedor
determinista `demo-agent`.

## Contrato HTTP

### `POST /api/respond`

Entrada válida:

```json
{ "message": "Hola" }
```

`message` debe ser texto no vacío tras eliminar espacios y contener como máximo
2000 caracteres. El cuerpo HTTP no puede superar 16 384 bytes.

Salida correcta:

```json
{ "reply": "Hola.", "agent": "ollama:qwen3:8b" }
```

Errores:

| Estado | Código | Significado |
|---|---|---|
| 400 | `invalid_request` | JSON inválido o mensaje fuera del contrato. |
| 502 | `agent_unavailable` | El adaptador o el modelo no produjo una respuesta válida. |
| 405 | — | Método no permitido. |

El servidor no inventa una respuesta si Ollama falla. Los errores internos se
reducen a un mensaje seguro para la interfaz.

## Adaptador Ollama

El adaptador usa `POST /api/chat` con `stream: false`, `think: false` y un
límite de 160 tokens generados. Estas opciones buscan una respuesta breve y
adecuada para reproducir en voz; no son una política clínica ni de seguridad.
Cada solicitud tiene un límite local de 45 segundos. Una respuesta HTTP no
exitosa, vacía o no textual se trata como error.

## Persistencia y privacidad

No hay base de datos, historial, cuenta, archivo de audio ni telemetría. El
texto viaja sólo entre el navegador local, el servidor local y Ollama local en
la configuración predeterminada. Si `OLLAMA_BASE_URL` cambia, esa frontera de
datos cambia y debe revisarse antes de usarla con información sensible.
