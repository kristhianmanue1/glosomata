# ADR-010: Phonon mediante Ollama local como TTS experimental

Estado: aceptado para implementación experimental
Fecha: 2026-10-27

## Contexto

El Operador pidió ofrecer voces mexicanas de Phonon como opción experimental.
El catálogo de Gradium identifica `Rebeca` y `Lalo` como voces es-mx; esa
etiqueta no acredita por sí misma la calidad percibida del acento. La matriz
actual mantiene Piper seleccionado. ADR-003 excluyó a Ollama como LLM del
núcleo y mantuvo el razonamiento en el consumidor.

## Decisión

Se incorpora `phonon_ollama` como adaptador opcional de `EngineTTS`. Envía
texto por stdin a `/usr/bin/curl` fijo y solicita síntesis a la API de Ollama en
`127.0.0.1:11434`. La URL es fija, sin proxy ni redirecciones, y el
adaptador no descarga modelos. Antes de seleccionar una voz, el probe
comprueba que el modelo local declare capacidad `speech` y registre el
identificador de voz. El modelo y la voz son explícitos en la matriz;
`kill_switch` de grupo de procesos es obligatorio. Un `bin` alternativo
declarado en la matriz se rechaza durante el probe.

El adaptador recibe el WAV completo, verifica PCM 16-bit, mono, 24 kHz,
lo guarda temporalmente con modo 0600, lo reproduce con `afplay` y lo
borra mediante el cierre normal de la operación. `stop` mata los
subprocesos locales de solicitud o reproducción y marca el turno como
truncado. No se afirma que Ollama cancele su inferencia interna.

Glosomata sigue sin abrir un servidor HTTP ni ejecutar un LLM. El
streaming de audio hacia el consumidor queda fuera de v1. Piper conserva
la selección por defecto; la adopción en la matriz habitual es una
decisión separada del Operador.

## Consecuencias y límites

- Ollama pasa a ser dependencia local opcional para este motor. Una matriz
  que lo declare requiere que Ollama, el modelo y la voz estén disponibles
  también al ejecutar `doctor` o `config validate`, aunque `selected:false`.
- Los datos se entregan al daemon local de Ollama. Su política de logs y
  retención debe evaluarse aparte; la garantía de glosomata no la cubre.
- El checkpoint `gradium/phonon-40m-es` declara CC BY-NC 4.0; no se
  habilita uso comercial por la licencia Apache-2.0 de glosomata ni por
  la licencia del catálogo de voces.
- El límite del adaptador es 16 MiB de WAV y 60 s por solicitud. Un
  formato distinto falla cerrado con `tts_failed`.

## Relación con ADR-003

Esta decisión acota la frase «Ollama fuera del núcleo» a la función de
LLM/orquestador. Ollama se usa aquí exclusivamente como proceso local de
síntesis invocado por el adaptador TTS; el núcleo no genera respuestas.
