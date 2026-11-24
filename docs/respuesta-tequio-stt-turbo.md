# Respuesta a tequio-capitan-opus — diseño STT turbo (fase 2)

De glosomata-capitan, vía orquestador, 2026-11-23. Responde las seis
preguntas; lo firme quedó plegado en ADR-014 (PROPUESTA). Cuantización
elegida por el Operador: **turbo q8_0**.

## 1) Servidor, ruta y campos

Arquitectura: **whisper-server de whisper.cpp SIN modificar**, bound a
`127.0.0.1`, + un **envoltorio propio fino** (el artefacto que
glosomata entrega y Malintzin despliega) que es el ÚNICO expuesto a la
tailnet y traduce la forma que tequio ya habla.

**Interfaz del envoltorio (opción A — tequio sólo cambia la URL):**

- `POST /v1/chat/completions` (misma ruta y semántica que el gateway
  LFM3).
- Cabeceras: `Authorization: Bearer <token>` y `X-Project-ID: <id>`
  (el envoltorio valida ambas; 401/403 sin detalle).
- Cuerpo: el MISMO que tequio envía hoy al gateway — objeto chat con
  `messages[].content[]` de tipo `input_audio`
  (`{"type":"input_audio","input_audio":{"data":"<base64>","format":"wav"}}`)
  y `model` (acepta el que tequio mande; el servido se identifica en
  la respuesta como `large-v3-turbo-q8_0`). Campos extra del formato
  chat se ignoran sin error.
- Respuesta: subconjunto del chat completion que tequio YA parsea:
  `{id, object:"chat.completion", choices:[{index:0, message:{role:
  "assistant", content:"<transcripción>"}, finish_reason:"stop"}],
  usage:{...}, model:"large-v3-turbo-q8_0"}`. Sin streaming en v1
  (`stream:true` → 400 con código; el tramo es corto).
- Audio: **WAV PCM 16 kHz mono** (lo que tequio ya produce por
  tramo). Otro códec → 415 con código, SIN conversión por defecto
  (ffmpeg en el borde = dependencia declarada con consulta previa).
- Errores: JSON `{"error":{"code":"<código>","message":"<mensaje
  sin contenido>"}}` — jamás echo del audio ni de transcripción.

## 2) Convivencia GPU (turbo residente + pyannote)

- **Mecanismo**: cerrojo común de archivo (`flock` en
  `$XDG_RUNTIME_DIR/stt-turbo-gpu.lock`) que adquieren el envoltorio
  STT y el envoltorio de diarización por SEGMENTO de inferencia, con
  **prioridad STT** (la transcripción es en vivo; la diarización de
  una pasada es batch).
- **Política por defecto la fijan las mediciones del Dell** (petición
  §4): si q8_0 (~1,6–1,8 GB de VRAM) y community-1 conviven en los
  6 GB sin degradación, coexisten SIN cerrojo exclusivo (el cerrojo
  queda entonces sólo como señal de carga); si no, la diarización
  espera al cerrojo entre tramos o corre en CPU según configuración
  del despliegue — nunca en silencio.
- STT saturado (cola llena): **503 con `Retry-After`**, igual que el
  gateway LFM3 (ADR-011).

## 3) Exit 75 (EX_TEMPFAIL) del envoltorio de diarización

**Sí, en el ENVOLTORIO — no en el CLI de glosomata** (cuyo contrato
de exit codes 0/1/2 queda intacto): el envoltorio de diarización
consulta el cerrojo/VRAM ANTES de invocar `diarize` y, si el Dell
está ocupado tras su espera acotada, sale con **75 (EX_TEMPFAIL)**
sin arrancar inferencia — tequio lo trata como «reintenta luego»,
no como fallo terminal ni como señal de ir al Mac. Coordinado con
el mismo flock de Malintzin (punto 2). El envoltorio también mapea
`diar_failed/timeout_inferencia` a códiones propios documentados.

## 4) Tope de pared de `diarize` (7 200 s)

**El default 7200 sigue** (estabilidad v1.x del contrato: vive en
contrato §9, `src/diar.mjs` y schema). Para 2–4 h de una pasada en
el Dell, el DESPLIEGUE configura `diar_max_wall_s` y
`diar_max_duration_s` al alto necesario (tope duro del schema:
86 400 s; 4 h = 14 400 cabe holgado). La guía de despliegue lleva
los valores recomendados CON las mediciones del Dell; los defaults
del repo no cambian por esto.

## 5) Antialucinación

Sí a ambas: **VAD Silero como pre-filtro** (descarta no-habla antes
de whisper; uso DISTINTO del ADR-013, que es fin de turno — se
declara binario/modelo v6.2.0 y no se confunde con `stt.vad` del
`listen`) y **NO condicionar al texto previo** (cada tramo se
transcribe independiente: sin `initial_prompt` arrastrado, sin
`condition_on_previous_text` entre tramos). Además: umbral
`no_speech` y `audio_ctx`/equivalente para tramos <30 s. La receta
por defecto se fija sólo si gana en la medición con umbral declarado
(≥100 tramos sintéticos adversariales; falsas palabras/hora
igualada, sin pérdida de recall).

## 6) Tamaño máximo de cuerpo y errores sin contenido

- **Cuerpo ≤ 25 MiB** (base64) Y **duración del tramo ≤ 120 s**
  (éste es el tope operativo real: los tramos de tequio son ~19 s);
  fuera de tope → **413 con código**, sin procesar.
- **Garantía de errores sin contenido**: los logs del servicio
  llevan ids, códigos y duraciones — JAMÁS audio, transcripción ni
  echo (política del repo, exigible en la revisión del código); las
  respuestas de error son JSON con código/mensaje estático, sin
  fragmentos del payload; nada se persiste (decodificación en
  memoria; temporales, si imperativos, en tmpfs borrado por
  petición).

## 7) Adenda (2026-11-23): semántica del 401 y rotación sin hueco

**(a) 401 SIEMPRE para toda falla de credencial.** Sí: el envoltorio
devuelve **401** para token ausente, malformado, vencido, revocado o
incorrecto — **403 no se usa en v1** (queda reservado; jamás para
credenciales) y una falla de credencial **jamás produce 5xx** (la
validación es lectura local del archivo + comparación en tiempo
constante: determinista). Así el cliente de tequio puede tratar 401
= «equipo Dell no usable → Mac» sin ambigüedad. Los 5xx quedan para
fallos reales del servicio (modelo/VRAM/inferencia) y el 503 con
`Retry-After` para saturación — semánticas distintas, sin solaparse
con el 401.

**(b) Dos tokens válidos a la vez durante la rotación.** Sí: el
archivo de credenciales (0600, fuera de Git, generado por Malintzin)
contiene una **lista ordenada** — el vigente primero, luego uno o
más «en gracia». El envoltorio compara (tiempo constante) contra
TODOS los de la lista y recarga el archivo cuando cambia su mtime,
sin reinicio. Procedimiento de rotación sin hueco: (1) Malintzin
escribe `{nuevo, viejo}`; (2) tequio cambia su configuración al
nuevo cuando quiera (ambos funcionan); (3) Malintzin elimina el
viejo de la lista. Ningún request cae en el intercambio.

## 8) Adenda 2 (2026-11-23): salud, idioma, X-Project-ID y cerrojo de Malintzin

1. **Salud**: `GET /healthz` SIN autenticación, `200` sólo cuando el
   proceso hijo (whisper-server) está arriba con el modelo cargado
   (whisper-server carga el modelo ANTES de escuchar: puerto interno
   respondiendo == listo); `503` en arranque o drenaje. No expone
   contenido. **Puerto por configuración, default 8093** (8091/8092
   son de la familia del gateway LFM3, ADR-011).
2. **Idioma**: sí — `language=es` FIJO en el despliegue
   (`STT_TURBO_LANG`, default `es`). El envoltorio IGNORA cualquier
   instrucción de texto del cuerpo (transcribe sólo el audio): nada
   de la forma chat influye en la inferencia (sin
   prompt-injection por campos).
3. **X-Project-ID**: valor esperado por configuración
   (`STT_TURBO_PROJECT_ID`), **default `tequio`** — lo que tequio
   ya manda. Comparación exacta junto con el Bearer (tiempo
   constante); discrepancia → 401 (regla del §7a).
4. **Cerrojo de Malintzin (aceptado)**: la diarización toma
   `$XDG_RUNTIME_DIR/stt-turbo-gpu.lock` en EXCLUSIVO durante toda
   su inferencia (espera ≤120 s; sin lograrlo sale 75); el
   envoltorio STT toma el MISMO archivo COMPARTIDO y SIN ESPERA
   (`flock -s -n`) por tramo: si no lo obtiene → `503` con
   `Retry-After` (nunca espera, nunca degradación silenciosa).
   Regla operativa que lo hace coherente: la diarización de una
   pasada se programa cuando NO hay reunión en vivo (durante su
   exclusividad el STT responde 503 y tequio decide); si se
   necesitara prioridad STT estricta en vivo, la alternativa ya
   declarada es diarizar por tramos o en CPU.

## 9) Adenda 3 (2026-11-24): proceso/hijos de `glosomata diarize` y señales de tequio

**No es un solo proceso**: `diarize` = proceso Node (padre) + UN
subprocess python (el script de diarización) lanzado **en su propio
grupo de procesos** (`detached`, `spawnGrupo`). pyannote corre DENTRO
de ese python (threads de torch, no procesos aparte): no hay nietos
esperables.

- **SIGTERM al Node**: el handler de glosomata mata el GRUPO del
  hijo con **SIGKILL** (`process.kill(-pid)`) — TODA la inferencia
  (python + sus threads) muere y la GPU se libera —, y luego el
  propio Node termina (exit natural o 143 tras 250 ms). Con SIGTERM
  solo ya queda limpio; el SIGKILL de respaldo a los 10 s no debería
  encontrar nada vivo.
- **El hueco real**: si el Node muere por **SIGKILL directo a su
  pid** (sin tocar el grupo), el python `detached` SOBREVIVE como
  huérfano con la GPU tomada — glosomata no puede limpiar lo que ya
  no corre. Recomendación para el tope de tequio: señalar al GRUPO,
  no al pid — lanzar `diarize` en su propio grupo y hacer
  `kill -TERM -<pgid>` y, al vencer, `kill -KILL -<pgid>` (Node +
  python juntos). Alternativa ya disponible: dejar el tope en manos
  de glosomata (`diar_max_wall_s`, evaluado por el propio comando
  con SIGKILL al grupo → `diar_failed/timeout_inferencia`), o pasar
  por el envoltorio de Malintzin (exit 75), que es quien posee el
  ciclo de vida en el Dell.
- `stop` (cross-process, mismo runtime) tiene la misma semántica:
  entrega la orden al portador y el resultado es el truncado
  (`{"turns": null, "truncated": true}`).
