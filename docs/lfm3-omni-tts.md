# LFM3-Omni: opción TTS por gateway local

Esta opción usa el gateway v2 de LFM3-Omni (misma máquina,
`127.0.0.1:8092`) como boca de síntesis en español. No instala ni
arranca el gateway: su ciclo de vida (`run/serve.sh` / `run/stop.sh`
del proveedor) es decisión del Operador.

## Preparación sin alterar la matriz habitual

Comprueba que el gateway está vivo y tiene la síntesis contratada:

```bash
/usr/bin/curl -q --noproxy '*' --proto '=http' --max-redirs 0 \
  --max-time 3 http://127.0.0.1:8092/v1/capabilities
# debe incluir "voz": true
```

Copia `glosomata.json` a un archivo de prueba fuera del repositorio.
En `engines.tts`, agrega el motor — no tiene claves propias: la URL
(loopback 8092) y la voz (fija `es`) las fija el adaptador:

```json
{
  "id": "lfm3-es",
  "adapter": "lfm3",
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
- Latencia medida por el proveedor: 2.0–4.7 s por frase (el gateway
  recarga el modelo en cada llamada).
- El texto entregado al gateway queda bajo la política de retención
  del proveedor (prompt en archivo 0600 borrado por petición,
  SPEC-i1-vs §2), fuera de la garantía de glosomata.

Fuentes: SPEC-i1-vs y `docs/contracts/handoff-glosomata-v1.md` en
[LFM3-Omni-FK](https://github.com/kristhianmanue1/LFM3-Omni-FK);
ADR-011 de este repositorio.
