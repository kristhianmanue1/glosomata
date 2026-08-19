# Hallazgos — verificación CLI + MCP (2026-08-18)

Verificación manual del CLI y del servidor MCP stdio, hecha sobre `main`
(commit `ba57a58`) con los tres motores TTS reales (`say`, `piper-claude`,
`kokoro`) y STT real (whisper.cpp vía micrófono). `npm test` en verde
(29/29 — `tests/*.test.mjs` incluye `mcp.test.mjs` y `stt.test.mjs`, ver
hallazgo #3) antes y después. Este documento es la entrega a equipo de
agentes; cada hallazgo abajo es una tarea independiente.

**Ronda adversarial (2026-08-18, mismo día):** los tres hallazgos
originales se re-verificaron contra el código y con pruebas repetidas.
El #1 se confirma sin cambios. El #2 y el #3 estaban sobre-reclamados en
la redacción inicial y quedan corregidos abajo — el propio autor de este
documento los escribió con datos parciales de una sola corrida.

## 1. MCP: método JSON-RPC desconocido no responde nada (BLOCKER)

**Dónde:** `src/mcp-core.mjs:83-121`, función `main()`.

**Qué pasa:** el `for await` sobre stdin sólo maneja `initialize`,
`notifications/initialized`, `tools/list` y `tools/call`. Cualquier otro
método (`resources/list`, `prompts/list`, o cualquier método futuro del
protocolo MCP) no entra en ninguna rama y no se escribe respuesta. Un
cliente MCP que espere respuesta a todo `id` enviado queda bloqueado sin
timeout propio del servidor.

**Reproducción:**
```bash
npm run mcp
# stdin: {"jsonrpc":"2.0","id":1,"method":"resources/list","params":{}}
# → sin salida por stdout, nunca
```

**Fix propuesto:** agregar un `else` final que responda error JSON-RPC 2.0
estándar:
```js
} else {
  rpc(id, undefined); // no — usar error, no result
}
```
Concretamente, `rpc()` sólo serializa `result`; hace falta una variante o
parámetro para el campo `error`:
```js
writeSync(1, `${JSON.stringify({
  jsonrpc: '2.0', id,
  error: { code: -32601, message: 'Method not found' },
})}\n`);
```
Cuidado: si `id` es `undefined` (notificación desconocida), no responder
nada es correcto — sólo enviar error cuando `id` está presente.

*Re-verificado en la ronda adversarial:* se relanzó `src/mcp.mjs` limpio,
se envió `initialize` (respondió normal) seguido de `resources/list`; a
los 3s no había llegado segunda respuesta por stdout. Confirmado, sin
cambios.

## 2. Kokoro: primera invocación ~95s, luego estable en ~8-10s (LOW, no MEDIUM)

**Dónde:** `src/tts/kokoro.mjs` + `src/tts/synthesize_kokoro.py`.

**Corrección de la ronda adversarial:** el hallazgo original decía "~90s
en sintetizar una frase corta" como si fuera el costo por llamada. Es
incorrecto — esa medición fue la *primera* invocación de Kokoro en este
entorno (posiblemente costo único de arranque en frío: compilación de
bytecode de Python, inicialización de onnxruntime, o similar). Tres
invocaciones posteriores midieron 8.00s, 8.32s y 9.62s de tiempo real
— comparable a `piper-claude` (~7s), no 10x más lento como se afirmó.

**Qué queda por revisar (bajado de severidad):** confirmar con el equipo
si ese primer costo de ~95s es reproducible tras un reinicio completo de
máquina/venv (cache de disco frío) o fue anómalo (p. ej. Gatekeeper
verificando la firma de un binario recién instalado en `.venv`). Si es
reproducible en frío, documentar como "primer `speak --engine kokoro`
tras instalar/actualizar el venv es lento" en vez de tratarlo como
latencia por turno.

**Sugerido:** no es bloqueante. Si se decide investigar, instrumentar
`synthesize_kokoro.py` con timestamps a stderr en la próxima ejecución en
frío (p.ej. tras `rm -rf .venv` + reinstalación) antes de asumir que hay
un problema de proceso-en-frío-por-llamada.

## 3. Servidor MCP: cobertura de test parcial, falta `tools/call` y concurrencia (MEDIUM, no "sin cobertura")

**Dónde:** `tests/mcp.test.mjs` (existe, contrario a lo dicho en la
versión original de este documento).

**Corrección de la ronda adversarial:** el hallazgo original afirmaba que
"nada ejercita `src/mcp-core.mjs` directamente". Falso — `npm test`
corre 29 tests, no 18 como se reportó primero (el conteo de 18 vino de
una corrida donde el glob `tests/*.test.mjs` no recogió `mcp.test.mjs` ni
`stt.test.mjs`, causa no determinada; una corrida posterior sí los
recogió los 29). `tests/mcp.test.mjs` ya cubre:
- `initialize` + `tools/list` por stdio real (spawn de `src/mcp.mjs`).
- Los 6 tools con `inputSchema.additionalProperties === false`.
- Rangos de `timeout_s` (`exclusiveMinimum`, `maximum`) y `required` de
  `speak`/`validate`.

**Lo que sí falta (el hallazgo real, con severidad correcta):** ningún
test ejercita `tools/call` en sí — ni casos de error (`speak` sin texto,
motor inexistente) ni la concurrencia documentada en el código ("stop es
procesado aunque un speak esté en curso", comentario en
`mcp-core.mjs:105-106`, fix BLOCKER ronda 3). Esa concurrencia se
verificó hoy sólo con un cliente stdio ad-hoc fuera del repo — no queda
como regresión permanente.

**Casos mínimos a agregar a `tests/mcp.test.mjs`:**
- `tools/call speak` sin `text` → `isError:true`, `usage`.
- `tools/call speak` con `engine` inexistente → `engine_unavailable`.
- `tools/call stop` enviado mientras un `speak` largo está en curso →
  responde antes que el `speak`, y el `speak` se resuelve luego con
  `isError:true`, `truncated:true` (regresión del fix de ronda 3).
- Método JSON-RPC desconocido → una vez resuelto el hallazgo #1, verificar
  que responde `-32601` y no cuelga.
- `validate` ok / fail / sesión expirada.

Reutilizar el helper `sesionMcp()` ya presente en `tests/mcp.test.mjs`
(spawn real de `src/mcp.mjs` + `readline` sobre stdout), evitando mocks
internos (política del repo: sin mocks del motor cuando el contrato es
observable por proceso).

## Verificación positiva (sin cambios necesarios)

- CLI: `speak`/`listen`/`stop`/`engines`/`templates`/`session`/`validate`
  — contratos de error (`usage`, `engine_unavailable`, `text_too_long`,
  `session_invalid`, `channel_busy`) se comportan según
  `docs/specs/specs-y-contratos-v1.md`.
- Half-duplex: `speak`/`listen` concurrentes devuelven `channel_busy`
  correctamente; `stop` interrumpe vía kill-switch de `process_group`.
- STT real (whisper.cpp + ffmpeg/avfoundation) transcribe correctamente
  en español sobre micrófono real.
- Los tres motores TTS (`say`, `piper-claude`, `kokoro`) reproducen audio
  real y devuelven `played:true`.
