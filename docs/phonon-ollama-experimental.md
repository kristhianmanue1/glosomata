# Phonon/Ollama: opción TTS experimental

Esta opción usa la API local de Ollama para sintetizar con Phonon. No
instala Ollama ni descarga modelos. El modelo debe existir y declarar
`speech`; la voz debe aparecer en sus metadatos. `Rebeca` y `Lalo`
figuran como es-mx en el catálogo de Gradium, pero la calidad del
acento requiere evaluación humana con las muestras.

## Estado en la matriz canónica

`phonon-rebeca` ya está declarado en `glosomata.json` (`selected:false`,
con su `kill_switch`), usable directamente con `--engine phonon-rebeca`
en CLI o `engine:"phonon-rebeca"` en MCP cuando el proceso comparte esa
matriz. `config validate` y `doctor` lo prueban como a cualquier motor
declarado: requieren Ollama local activo.

## Preparación sin alterar la matriz habitual

Este flujo —copiar la config fuera del repositorio y agregar motores—
queda como el camino para probar otras voces y modelos (p. ej. `Lalo`)
sin tocar la matriz; ya no es el único camino para `Rebeca`.

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
  "id": "phonon-lalo",
  "adapter": "phonon_ollama",
  "model": "nombre-del-modelo-local",
  "voice": "Lalo",
  "selected": false,
  "kill_switch": {
    "type": "subprocess_kill",
    "target": "process_group",
    "max_latency_ms": 500
  }
}
```

Cada motor agregado necesita un ID único en esa matriz copiada:
`config validate` rechaza ids duplicados, y la matriz canónica ya
declara `phonon-rebeca` —por eso el ejemplo usa otra voz. Sustituye el
modelo por un nombre que `ollama show` confirme. Una instalación
estándar de `phonon:es` puede exponer sólo `default`; los nombres del
catálogo no se vuelven utilizables por declararlos en esta matriz.

```bash
GLOSOMATA_CONFIG=/ruta/config-phonon.json node src/cli.mjs config validate
GLOSOMATA_CONFIG=/ruta/config-phonon.json node src/cli.mjs speak --engine phonon-lalo --text "Hola, ¿cómo estás?"
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
- **Latencia observada** (ensayo real 2026-11-10, macOS arm64, Ollama
  local; `speak` completo = síntesis + reproducción bloqueante): ~4,5 s
  para una frase corta y ~7–23 s para respuestas de una a tres frases.
  Es una observación puntual, NO una cota contratada ni garantía.
- `stop` interrumpe los subprocesos locales. La cancelación de la
  inferencia dentro del daemon de Ollama no está comprobada.
- **Runtime y contención**: la contención (`channel_busy`) y el alcance
  de `stop` operan por directorio de runtime; un consumidor con runtime
  propio queda fuera de esa contención (detalle en
  `docs/specs/contrato-consumo-agentes-v1.md` §5.1).
- El WAV temporal se borra al terminar la operación. Los logs de
  glosomata no incluyen texto; la retención del daemon Ollama queda
  fuera de esa garantía.
- El checkpoint Phonon español declara CC BY-NC 4.0. Comprueba la
  licencia del modelo concreto antes de usarlo comercialmente.

Fuentes: [Ollama speech](https://github.com/ollama/ollama/blob/main/docs/capabilities/speech.mdx),
[Phonon español](https://huggingface.co/gradium/phonon-40m-es),
[catálogo de voces](https://huggingface.co/gradium/phonon-voices).
