# ADR-011: LFM3-Omni como motor TTS vía gateway local

Estado: aceptado para implementación experimental
Fecha: 2026-11-10

## Contexto

El issue #35 y el handoff del proveedor
(`docs/contracts/handoff-glosomata-v1.md` en LFM3-Omni-FK) entregan un
gateway local v2 en `127.0.0.1:8092` con `POST /v1/audio/speech`
(SPEC-i1-vs): voz fija `es`, WAV completo, `input` de 1..600 caracteres
sin controles, una síntesis a la vez (503 sin cola) y timeout de
síntesis de 120 s. El plan de consumo (`docs/plans/PLAN-lfm3-omni-consumo.md`)
fija la división de responsabilidades: LFM3 = inferencia, Glosomata =
captura/reproducción/motores de voz, Lalia-Akuo = turnos. El ADR-003
excluye LLMs del núcleo; el ADR-010 sentó el precedente de motor HTTP
de loopback (`phonon_ollama`).

## Decisión

Se incorpora `lfm3` como adaptador opcional de `EngineTTS`, sin claves
de configuración propias: URL fija `http://127.0.0.1:8092`, voz fija
`es`; `bin` opcional sólo si es `/usr/bin/curl` (cualquier otro valor
se rechaza en el probe, como en `phonon_ollama`). El texto viaja por
stdin de curl — nunca en argv ni en logs. El probe exige
`GET /v1/capabilities` con `voz:true`: sin esa declaración el gateway
no tiene contratada la síntesis y el motor queda no disponible
(fail-closed).

La frontera de entrada del proveedor se aplica ANTES de solicitar:
más de 600 caracteres (contados en code points, la métrica del
proveedor) responde `text_too_long`; caracteres de control (incluidos
`\n` y `\t`, que la canonización de glosomata conserva) o texto sin
imprimibles responden `not_supported`. Ambos son códigos existentes de
la taxonomía; no se inventan nuevos. El 503 `overloaded` del proveedor
(exclusión mutua, sin cola) y cualquier otro estado HTTP son
`tts_failed`: el adaptador no encola ni reintenta — el reintento
acotado es decisión del consumidor (contrato de consumo C2).

El WAV completo se valida — RIFF/WAVE con chunks íntegros (un tamaño
declarado mayor que los bytes recibidos falla cerrado), PCM 16-bit y
muestras no vacías: frontera igual o más estricta que la del propio
gateway; si el proveedor emitiera otro formato, glosomata falla
cerrado antes que reproducirlo ciego — y se reproduce con `afplay`
tras escribirlo con modo 0600. `stop` mata los
subprocesos locales de solicitud y reproducción y marca el turno
truncado; no se afirma que el gateway cancele su síntesis interna. El
ciclo de vida de 8091/8092 es del Operador: glosomata jamás los
arranca ni los administra.

## Consecuencias y límites

- Una matriz que declare `lfm3` exige gateway vivo con voz contratada
  al ejecutar `doctor` o `config validate`, aun con `selected:false`
  (misma regla que `phonon_ollama`).
- El texto se entrega al gateway local del equipo; su política de
  retención (`prompt.txt` 0600 borrado por petición, SPEC-i1-vs §2) es
  del proveedor y queda fuera de la garantía de glosomata.
- Latencia por frase medida por el proveedor: 2.0–4.7 s (recarga de
  modelo por llamada). No apto hoy para turnos conversacionales
  rápidos; el bucle híbrido documentado por el proveedor usa los
  motores propios calientes y LFM3 como boca opcional.
- Sólo español y voz fija. La selección de voz premium (decisión B2
  del Operador) y el modo espejo realtime WS quedan fuera de esta
  decisión y exigen gates propios.
- Límites del adaptador: respuesta ≤ 16 MiB (sobre del código HTTP
  incluido), `--max-time` 120 s.

## Relación con ADR-003 y ADR-010

Mismo alcance que el ADR-010: LFM3 se usa exclusivamente como proceso
local de síntesis consumido por loopback; el núcleo no genera
respuestas ni incorpora un LLM. El ADR-003 permanece intacto.
