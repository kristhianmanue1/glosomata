# Phonon/Ollama: opción TTS experimental

Esta opción usa la API local de Ollama para sintetizar con Phonon. No
instala Ollama ni descarga modelos. El modelo debe existir y declarar
`speech`; la voz debe aparecer en sus metadatos. `Rebeca` y `Lalo`
figuran como es-mx en el catálogo de Gradium, pero la calidad del
acento requiere evaluación humana con las muestras.

## Preparación sin alterar la matriz habitual

Comprueba el modelo y las voces que **tu** instalación expone:

```bash
ollama list
ollama show nombre-del-modelo
```

Copia `glosomata.json` a un archivo de prueba fuera del repositorio.
En `engines.tts`, agrega motores como éstos, conservando un único
`selected:true` (por ejemplo, Piper):

```json
{
  "id": "phonon-rebeca",
  "adapter": "phonon_ollama",
  "model": "nombre-del-modelo-local",
  "voice": "Rebeca",
  "selected": false,
  "kill_switch": {
    "type": "subprocess_kill",
    "target": "process_group",
    "max_latency_ms": 500
  }
}
```

Para `Lalo`, usa otro ID y `"voice":"Lalo"`. Sustituye el modelo por
un nombre que `ollama show` confirme. Una instalación estándar de
`phonon:es` puede exponer sólo `default`; los nombres del catálogo no
se vuelven utilizables por declararlos en esta matriz.

```bash
GLOSOMATA_CONFIG=/ruta/config-phonon.json node src/cli.mjs config validate
GLOSOMATA_CONFIG=/ruta/config-phonon.json node src/cli.mjs speak --engine phonon-rebeca --text "Hola, ¿cómo estás?"
```

`doctor` y `config validate` prueban **todos** los motores declarados,
incluidos los no seleccionados: Ollama, el modelo y la voz deben estar
disponibles cuando se use esa matriz. El motor habitual no cambia por
agregar una opción con `selected:false`. MCP también acepta
`engine:"phonon-rebeca"` cuando su proceso usa la misma matriz.

## Alcance operativo

- Requiere macOS arm64, `/usr/bin/curl`, `afplay` y Ollama local escuchando en
  `127.0.0.1:11434`. No hay URL configurable ni conexión externa.
- Envía texto por stdin a `curl`; el WAV completo se valida antes de
  reproducirlo. Glosomata no entrega audio incremental al consumidor.
- `stop` interrumpe los subprocesos locales. La cancelación de la
  inferencia dentro del daemon de Ollama no está comprobada.
- El WAV temporal se borra al terminar la operación. Los logs de
  glosomata no incluyen texto; la retención del daemon Ollama queda
  fuera de esa garantía.
- El checkpoint Phonon español declara CC BY-NC 4.0. Comprueba la
  licencia del modelo concreto antes de usarlo comercialmente.

Fuentes: [Ollama speech](https://github.com/ollama/ollama/blob/main/docs/capabilities/speech.mdx),
[Phonon español](https://huggingface.co/gradium/phonon-40m-es),
[catálogo de voces](https://huggingface.co/gradium/phonon-voices).
