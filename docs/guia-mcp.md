# Guía de consumo MCP

Cómo usar glosomata como servidor MCP desde un agente u orquestador.
Contrato normativo: `docs/specs/specs-y-contratos-v1.md` §MCP v1.

## Registro en el cliente

Servidor **stdio** (sin socket, sin HTTP); el cliente hereda el proceso:

```json
{
  "mcpServers": {
    "glosomata": {
      "command": "node",
      "args": ["/ruta/absoluta/a/glosomata/src/mcp.mjs"],
      "cwd": "/ruta/absoluta/a/glosomata"
    }
  }
}
```

`cwd` importa: la matriz de motores (`glosomata.json`) y los binarios
relativos (`.venv/bin/piper`, whisper) se resuelven desde ahí. Para otra
ruta de configuración, exporta `GLOSOMATA_CONFIG` en `env` del cliente.

Protocolo: JSON-RPC 2.0 por líneas. `initialize` (protocolVersion
`2024-11-05`), `tools/list`, `tools/call`, `ping`. Requests desconocidos
→ `-32601`; notificaciones → silencio; arrays (batch) y envelopes
inválidos → `-32600`.

## Tools

| Tool | Args | Qué hace |
|---|---|---|
| `speak` | `text` (requerido), `engine?` | reproduce por voz localmente; `{played, engine, echo, truncated}` |
| `listen` | `timeout_s?` (0<v≤120) | captura una **ventana fija** de hasta `timeout_s` y transcribe; la voz NO corta la captura — espera el timeout completo |
| `stop` | — | interrumpe la operación de canal activa (kill-switch) |
| `list_engines` | — | matriz de disponibilidad TTS/STT |
| `list_templates` | — | catálogo de plantillas base |
| `validate` | `session` (objeto inline), `text` | evalúa texto contra plantilla+turno |

Notas: el `≤2000` del schema de `speak` es sobre el texto crudo; el
límite aplicado es post-canonización contra `constraints.max_text_chars`
(con config menor, textos ≤2000 fallan con `text_too_long`). El default
de `timeout_s` por MCP es fijo (`10`); `constraints.listen_default_timeout_s`
de la matriz rige sólo el CLI.

## Semántica del canal

- **Half-duplex**: una operación de canal a la vez (intra o
  cross-process). Segunda operación concurrente → `channel_busy`.
- **`stop` es despachado en curso**: si llega mientras un `speak` largo
  corre, `stop` responde de inmediato y el `speak` se resuelve luego con
  `isError:true`, `played:false`, `truncated:true`. Un `listen`
  interrumpido por `stop` se resuelve con error `stopped`.
- **`echo`** está siempre presente: texto canonicalizado (NFC,
  inaudibles fuera) si la reproducción fue completa, `null` en caso
  contrario. Si hay texto en `echo`, sonó entero.
- **`listen`** captura la ventana completa y clasifica post-hoc: silencio
  (RMS bajo) → `mic_timeout`; luego transcribe con whisper.

## Flujo de turno con plantilla (típico)

1. `session new --template confirmar` vía CLI (la sesión la posee el
   agente; el servidor MCP sólo la recibe inline en `validate`).
2. `speak` con la pregunta al humano.
3. `listen` → transcripción del humano.
4. `validate {session, text: transcripción}` →
   `{result: "ok", next_turn: 1}` o `{result: "fail", expected, next_turn}`.
   El agente aplica el `next_turn` a SU copia de la sesión — glosomata
   jamás la muta.
5. Repite o abandona según SU política: objeciones, reintentos y
   `session_abandoned` los decide el agente (ADR-001), no el canal.

## Códigos de error

Taxonomía cerrada, mismos códigos que el CLI, siempre en
`content[0].text` con `isError:true`:

`engine_unavailable`, `tts_failed`, `stt_failed`, `mic_denied`,
`mic_timeout`, `audio_device_error`, `template_invalid`, `not_found`,
`text_too_long`, `session_invalid`, `session_expired`,
`session_abandoned`, `channel_busy`, `not_supported`,
`config_unreadable`, `usage`, `internal_error` — más `stopped` cuando
`stop` interrumpe un `listen` en curso.

Fail-closed ante todo: motor sin `kill_switch` en la matriz aparece con
`available:false` y no es seleccionable; sesión expirada o corrupta →
`session_expired` / `session_invalid`, nunca éxito inferido.

## Privacidad

Sin APIs de terceros, sin persistencia: audio y texto mueren con el
proceso. El servidor loguea a stderr sólo ids, códigos y duraciones —
nunca texto, patrón, transcripción ni echo. Si tu cliente captura
stderr, esa política se mantiene (ver `SECURITY.md`).
