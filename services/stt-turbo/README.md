# services/stt-turbo — envoltorio HTTP del whisper-server (Dell)

Artefacto de despliegue de **ADR-014 (ACEPTADO)**: envoltorio HTTP fino
delante de un `whisper-server` de whisper.cpp **sin modificar** (proceso
hijo, bound `127.0.0.1`). Expone la forma `POST /v1/chat/completions` +
`input_audio` que tequio ya habla al gateway LFM3: tequio sólo cambia la
URL. Es **código muerto para el núcleo** de glosomata (contrato de
consumo §2.6): la CLI/MCP no lo ejecuta, no lo instala y ningún test del
núcleo lo importa.

- Node ≥ 20, ESM, **cero dependencias npm** (sólo stdlib).
- Privacidad: nada de audio ni transcripción en disco (decodificación en
  memoria); logs a stderr con SOLO ids, códigos y duraciones; errores con
  código y mensaje estático, sin echo.
- Sin reinicio automático del hijo en v1: lo reinicia systemd.

## Variables de entorno

| Variable | Default | Qué controla |
|---|---|---|
| `STT_TURBO_PORT` | `8093` | puerto público del envoltorio (8091/8092 son de la familia LFM3, ADR-011) |
| `STT_TURBO_BIND` | `127.0.0.1` | dirección de escucha. **Sólo** loopback o la IP de tailnet; `0.0.0.0` aborta el arranque (fail-closed) |
| `STT_TURBO_PROJECT_ID` | `tequio` | valor esperado de `X-Project-ID` |
| `STT_TURBO_TOKENS` | — | ruta del archivo de tokens (0600, fuera de Git) |
| `STT_TURBO_LANG` | `es` | idioma FIJO enviado al hijo; nada del cuerpo lo cambia |
| `STT_TURBO_WHISPER_BIN` | — | binario `whisper-server` del build del lock |
| `STT_TURBO_MODEL` | — | ruta del espejo local `ggml-large-v3-turbo-q8_0.bin` |
| `STT_TURBO_MODEL_SHA256` | — | si se fija, el arranque verifica el sha256 del espejo y aborta si no coincide (fail-closed). Pendiente del manifiesto oficial (ver `build.lock.json`) |
| `STT_TURBO_INTERNAL_PORT` | aleatorio | puerto loopback del hijo |
| `STT_TURBO_QUEUE` | `4` | tope de peticiones EN ESPERA (+1 en inferencia); desborde → 503 |
| `STT_TURBO_LOCK` | `auto` | `none` desactiva el cerrojo (SOLO desarrollo) |
| `STT_TURBO_LOCK_SLEEP_S` | `300` | tope del `sleep` del tenedor del cerrojo (≥ `STT_TURBO_INFERENCIA_MS` para no perder el cerrojo con la inferencia en curso) |
| `STT_TURBO_INFERENCIA_MS` | `180000` | timeout de una inferencia contra el hijo |
| `XDG_RUNTIME_DIR` | — | origen de la ruta del cerrojo `$XDG_RUNTIME_DIR/stt-turbo-gpu.lock` |

## Archivo de tokens y rotación sin hueco (§7b)

Archivo de texto, **una línea por token**, la primera es la vigente y
las siguientes quedan «en gracia». Perms 0600 (perms más abiertos =>
lista vacía => todo 401, fail-closed). El envoltorio recarga el archivo
cuando cambia su mtime, **sin reinicio**, y compara en tiempo constante
contra TODAS las líneas.

Rotación en 3 pasos (Malintzin):

1. Añade el nuevo arriba sin retirar el viejo:
   `printf 'nuevo\nviejo\n' > tokens.new && chmod 600 tokens.new && mv tokens.new tokens`
2. Tequio cambia su configuración al nuevo cuando quiera (ambos valen).
3. Retira el viejo: `printf 'nuevo\n' > tokens.new && chmod 600 tokens.new && mv tokens.new tokens`

Ningún request cae en el intercambio.

## Cerrojo GPU (protocolo de Malintzin, aceptado §8.4)

Por TRAMO de inferencia el envoltorio toma
`$XDG_RUNTIME_DIR/stt-turbo-gpu.lock` **COMPARTIDO y SIN ESPERA**
(`flock -s -n`); la diarización lo toma EXCLUSIVO (espera ≤120 s, sin
lograrlo sale 75). Implementación zero-dep: un proceso
`flock -s -n <ruta> sleep <tope>` (en grupo propio) retiene el fd;
**liberar es matar al grupo entero** — `flock` sin `-F` hace fork y el
`sleep` hereda el fd del cerrojo, así que matar sólo al padre no
libera nada.

- No obtenido → `503` con `Retry-After: 2` (nunca espera, nunca
  degradación silenciosa).
- Host sin `flock`(1) (macOS) o sin `XDG_RUNTIME_DIR` → **fail-closed
  503** (`cerrojo_no_disponible`), salvo `STT_TURBO_LOCK=none`
  explícito de desarrollo.
- Residual declarado: la adquisición se infiere de que el tenedor
  sigue vivo tras una gracia de 150 ms; un `flock -n` que tarde más en
  FALLAR se leería como adquirido. El `sleep` del tenedor nunca expira
  antes que el timeout de inferencia (piso atado en código).
- Regla operativa: la diarización de una pasada se programa cuando NO
  hay reunión en vivo; durante su exclusividad el STT responde 503 y
  tequio decide.

## Interfaz

- `POST /v1/chat/completions` — headers `Authorization: Bearer <token>`
  y `X-Project-ID: <id>`. Cuerpo chat con
  `messages[].content[].input_audio` (`data` base64, `format:"wav"`).
  Todo lo demás del formato chat se ignora (el texto no influye). Se
  toma el PRIMER `input_audio`. Respuesta: subconjunto chat completion
  con `model:"large-v3-turbo-q8_0"` y `usage` stub (whisper-server no
  expone tokens). `stream:true` → 400.
- `GET /healthz` — **sin auth**, `200` cuando el puerto loopback del
  hijo responde, `503` en caso contrario; cuerpo vacío.

## Límites y errores (taxonomía cerrada del artefacto)

| Tope | Valor | Fallo |
|---|---|---|
| cuerpo | 25 MiB | 413 `cuerpo_demasiado_grande` |
| duración del tramo | 120 s | 413 `audio_demasiado_largo` |
| audio | WAV RIFF PCM 16 kHz **mono** s16le, sin conversión; los chunks `data` se SUMAN para la duración (nadie esconde tramo en un segundo chunk) | 415 (ver códigos) |
| cola | 4 en espera | 503 `cola_llena` + `Retry-After` |

Códigos (`{"error":{"code","message"}}`, mensaje estático): el 401 de
credenciales es exactamente `{"error":{"code":"unauthorized"}}` para
ausente/malformada/vencida/revocada/incorrecta/proyecto distinto — 403
no se usa y las credenciales **jamás** producen 5xx. 5xx son fallos
reales: `inferencia_fallida` (502), `hijo_no_disponible` / cola /
cerrojo (503). 4xx de forma: `request_invalido`, `streaming_no_soportado`,
`audio_ausente`, `codec_no_soportado`, `tasa_no_soportada`,
`canales_no_soportados`, `formato_audio_invalido`; rutas:
`ruta_desconocida`, `metodo_no_permitido`.

Esta es la taxonomía **propia del artefacto** (no la del núcleo de
glosomata): `services/` no consume ni extiende la del CLI/MCP.

## Unidad systemd `--user` (Dell)

```ini
# ~/.config/systemd/user/stt-turbo.service
[Unit]
Description=glosomata stt-turbo (envoltorio whisper-server)
After=network-online.target

[Service]
Environment=STT_TURBO_PORT=8093
Environment=STT_TURBO_PROJECT_ID=tequio
Environment=STT_TURBO_TOKENS=%h/.config/stt-turbo/tokens
Environment=STT_TURBO_WHISPER_BIN=%h/.local/bin/whisper-server
Environment=STT_TURBO_MODEL=%h/.local/share/whisper/ggml-large-v3-turbo-q8_0.bin
Environment=STT_TURBO_MODEL_SHA256=<sha256 del manifiesto oficial>
Environment=XDG_RUNTIME_DIR=/run/user/%U
ExecStart=/usr/bin/node /ruta/al/repo/glosomata/services/stt-turbo/servidor.mjs
Restart=on-failure
# El servicio NO reinicia al hijo por sí solo (v1): esta unidad lo hace.

[Install]
WantedBy=default.target
```

Tailnet: apuntar `STT_TURBO_BIND` a la IP 100.x.y.z de la interfaz
tailscale del Dell y restringir el acceso por ACL de tailscale +
firewall. El binario systemd no abre nada más; jamás `0.0.0.0`.

## Build y modelos

`build.lock.json` (esqueleto versionado): tag+sha de whisper.cpp, flags
cmake (`GGML_CUDA`, `CMAKE_CUDA_ARCHITECTURES=75` para la RTX 2060),
sha256 del binario construido y del modelo q8_0 contra el manifiesto
oficial. Los valores `"PENDIENTE"` los fija Malintzin al construir;
el repo no inventa hashes. Descargas: bajo la autorización en cadena de
ADR-014 (quien despliega descarga; el servicio verifica fail-closed).

## Tests

`tests/stt-turbo.test.mjs` (suite del repo): hijo falso en loopback,
tokens en tmp y capa de cerrojo inyectada. Sin whisper real, sin Linux,
sin `flock` real — ver «no verificado» en el informe del ejecutor.
