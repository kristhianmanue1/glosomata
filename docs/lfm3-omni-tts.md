# LFM3-Omni: opción TTS por gateway local

Esta opción usa el gateway v2 de LFM3-Omni (misma máquina,
`127.0.0.1:8092`) como boca de síntesis en español. No instala ni
arranca el gateway: su ciclo de vida (`run/serve.sh` / `run/stop.sh`
del proveedor) es decisión del Operador.

## Preparación sin alterar la matriz habitual

Crea el archivo de credencial FUERA del repositorio, con modo 0600 y
exactamente dos líneas. El token lo emite el Operador del gateway (su
hash vive en `config/tokens.json` del proveedor, proyecto `glosomata`,
scopes `infer:text/infer:audio/speech:synthesize`); el secreto no debe
vivir en este repo, en argv ni en logs:

```bash
install -m 600 /dev/null ~/.config/glosomata/lfm3-auth.txt
printf 'Authorization: Bearer <token>\nX-Project-ID: glosomata\n' \
  >> ~/.config/glosomata/lfm3-auth.txt
```

Comprueba que el gateway está vivo y acepta la credencial:

```bash
/usr/bin/curl -q --noproxy '*' --proto '=http' --max-redirs 0 \
  --max-time 3 --header @"$HOME/.config/glosomata/lfm3-auth.txt" \
  http://127.0.0.1:8092/v1/capabilities
# debe responder 200 con "voz": true
```

Copia `glosomata.json` a un archivo de prueba fuera del repositorio.
En `engines.tts`, agrega el motor. La URL (loopback 8092) y la voz
(fija `es`) las fija el adaptador; la única clave de configuración es
`auth_file`, con ruta absoluta (ni `stat` ni curl expanden `~`):

```json
{
  "id": "lfm3-es",
  "adapter": "lfm3",
  "auth_file": "/Users/tu-usuario/.config/glosomata/lfm3-auth.txt",
  "selected": false,
  "kill_switch": {
    "type": "subprocess_kill",
    "target": "process_group",
    "max_latency_ms": 500
  }
}
```

```bash
GLOSOMATA_CONFIG=/ruta/config-lfm3.json node src/cli.mjs config validate
GLOSOMATA_CONFIG=/ruta/config-lfm3.json node src/cli.mjs speak --engine lfm3-es --text "Hola, ¿cómo estás?"
```

`doctor` y `config validate` prueban **todos** los motores declarados,
incluidos los no seleccionados: el gateway debe estar disponible cuando
se use esa matriz. El motor habitual no cambia por agregar esta opción
con `selected:false`. MCP también acepta `engine:"lfm3-es"` cuando su
proceso usa la misma matriz.

## Alcance operativo

- Requiere macOS (`afplay`), `/usr/bin/curl` y el gateway v2 escuchando
  en `127.0.0.1:8092` con `voz:true` en capabilities. URL fija, sin
  proxy, sólo loopback.
- Credencial por `auth_file` (0600, dos cabeceras): curl la lee directo
  con `--header @ruta`; el token nunca entra al proceso de glosomata.
  Archivo ausente, con permisos distintos de 0600 o rechazado por el
  gateway → motor no disponible / `tts_failed` (fail-closed).
- Cada operación (speak, engines, config validate, doctor) consume una
  sonda autenticada contra el bucket del proyecto (60 rpm, ráfaga 5):
  un agente conversacional que sondee por turno puede agotarla y ver
  el motor no disponible hasta repostar. La cuota es del Operador.
- Frontera de entrada del motor: 1..600 caracteres (code points) y sin
  caracteres de control. El texto multilínea o con tabuladores
  responde `not_supported` (la canonización de glosomata no los
  elimina) y más de 600 responde `text_too_long`; ambos se rechazan
  antes de solicitar.
- Una síntesis a la vez en el gateway: si otra va en curso responde
  503 sin cola y `speak` falla `tts_failed`; el reintento acotado lo
  decide el consumidor, no el adaptador.
- WAV completo validado (RIFF/WAVE, PCM 16-bit, chunks íntegros,
  muestras no vacías), escrito 0600, reproducido con `afplay` y
  borrado al cierre de la operación. `stop` interrumpe los subprocesos
  locales de solicitud y reproducción.
- Latencia de varios segundos por frase (2.0–4.7 s medidos por el
  proveedor; 6–9 s observados en vivo desde glosomata): el gateway
  recarga el modelo en cada llamada.
- El texto entregado al gateway queda bajo la política de retención
  del proveedor (prompt en archivo 0600 borrado por petición,
  SPEC-i1-vs §2), fuera de la garantía de glosomata.

Fuentes: SPEC-i1-vs y `docs/contracts/handoff-glosomata-v1.md` en
[LFM3-Omni-FK](https://github.com/kristhianmanue1/LFM3-Omni-FK);
ADR-011 de este repositorio.
