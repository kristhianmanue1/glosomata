# Especificaciones y contratos v1 (F1, revisados tras ronda adversarial 2)

## SPEC-1: turno de voz (REQ-1, 3, 5, 9–12)

Comportamiento: `speak` reproduce texto por el motor seleccionado y
devuelve `{played, engine, echo, truncated}` — `echo` = texto
canonicalizado, sólo con reproducción completa (`null` en caso
contrario); `played:false` ante cualquier interrupción. `listen`
captura una ventana fija de hasta timeout (la voz no corta la captura),
clasifica silencio post-hoc por RMS (`mic_timeout`) y transcribe.

Casos:
- DADO motor disponible CUANDO speak ENTONCES audio en ≤5s de cola, exit 0.
- DADO motor ausente (probe fail) CUANDO speak ENTONCES
  `engine_unavailable`, sin audio parcial, otros motores no afectados.
- DADO kill-switch (señal al proceso/grupo, o stop) CUANDO speak/listen
  ENTONCES corte inmediato vía flag atómico poll-eado por el loop de
  playback; `played:false`; temporales borrados.
- DADO silencio > timeout CUANDO listen ENTONCES `mic_timeout`, estado
  limpio.
- DADO dos operaciones de canal concurrentes (intra o cross-process)
  CUANDO la segunda arriva ENTONCES `channel_busy` (flock global).

Invariantes: 100% local; temporales en dir 0700 per-user, borrados al
cierre de cada operación y barridos por edad; logs sólo
ids/códigos/duraciones, JAMÁS texto, patrón, transcripción ni echo;
logs MCP a stderr.

## SPEC-2: negociación de plantilla (REQ-3, 7)

Comportamiento: `templates --list` entrega plantillas base por tipo
(confirmar, informar, preguntar, libre); el agente elige una, crea la
propia, o consulta a su orquestador. `session new --template <id>` acuña
sesión. `validate` evalúa texto contra plantilla+turno.

Casos:
- DADO plantilla confirmar CUANDO validate "sí" ENTONCES ok, next_turn+1.
- DADO plantilla con objections CUANDO el humano objeta ENTONCES el
  agente lo detecta contra `objections` (dato consultivo) y decide su
  política de reintento; `validate` responde sólo ok|fail. Glosomata NO
  cuenta reintentos NI emite session_abandoned por sí mismo (ADR-001:
  la sesión es metadata del agente); el código queda en la taxonomía
  para que el agente lo reporte al abandonar.
- DADO sesión libre CUANDO validate ENTONCES ok siempre (no-op declarada;
  REQ-11 conserva sólo echo-back en modo libre).
- DADO plantilla con expectation intent-free CUANDO validarla ENTONCES
  `not_supported` (excluida de v1, ADR-003).

Invariantes: validación es función pura; glosomata jamás muta sesiones;
sólo validate sobre input humano avanza turno (el agente lo aplica).

## CONTRATO: CLI v1

Operaciones: speak --text [--engine]; listen [--timeout]; stop; engines;
version; doctor; templates [--list|--show id]; session new
[--template id]; validate --session archivo --text str; config list;
config get engines|constraints — lectura CRUDA de la matriz (sin
probes ni campos derivados; `config validate` juzga, la lectura no).
Sección: lista cerrada, sin traversal. `config validate [--file ruta]`:
veredicto estilo `doctor` — estructura (schema formal) + probes +
kill_switch; JSON por stdout y stderr vacío; exit 0 sólo si todo lo
declarado pasa (stt sin claves declaradas no invalida). Estructura
incluye la semántica de matriz: ids únicos en engines.tts y
exactamente un motor `selected:true`. `config set <archivo>`: replace
atómico de la matriz completa — candidato a temporal 0600 en el
directorio del destino, validación completa sobre el temporal, backup
previo (retención: últimas 5) y `rename`; cualquier fallo →
`config_write_failed` con el veredicto y el original intacto. El
schema garantiza que no se persistan campos derivados. Semántica
observable del set: el destino queda con modo 0600 (el del temporal);
los backups viven en `$GLOSOMATA_RUNTIME/glosomata-<uid>/backups/`
(retención: últimas 5, la respuesta devuelve el basename); las rutas
relativas del candidato se resuelven contra el CWD del proceso —
misma regla que la guía MCP (`cwd` importa): valida y escribe desde
donde correrás glosomata; set exige que TODO motor declarado pase
probes («validación completa», P1.2/ADR-008) — un motor caído bloquea
el set: corrígelas o retíralo del candidato (el backup permite
volver); si el destino es un symlink, `rename` lo reemplaza por un
archivo regular y el target queda intacto; un proceso muerto entre
temporal y rename deja `.glosomata-set-*.tmp` huérfano (0600,
ignorado por git, borrable a mano).

Exit codes: 0 ok; 1 error (código en stderr); 2 usage. Excepción
`doctor`: exit 1 = no operativo, con veredicto JSON por stdout y stderr
vacío (ver contrato de consumo §7.1). Señal `SIGTERM`: trunca la
operación en curso; el exit es el natural si el truncado asienta
dentro de la gracia (250 ms) o `143` si decide la gracia — fuera de la
taxonomía 0/1/2 por ser terminación por señal, no resultado de
operación.

Errores (taxonomía cerrada): engine_unavailable, tts_failed, stt_failed,
mic_denied, mic_timeout, audio_device_error, template_invalid,
not_found, text_too_long, session_invalid, session_expired,
session_abandoned, channel_busy, not_supported, config_unreadable,
config_write_failed, usage, internal_error. `stopped` no es de la
taxonomía: señala exclusivamente la interrupción de un `listen` por
`stop`. `config_write_failed`: fallo de la escritura gobernada de
config (comandos `config`, plan de configuración P1).

## CONTRATO: MCP v1

Transporte: stdio únicamente, heredado del orquestador. Sin socket/HTTP.
Logs a stderr, jamás stdout (corrompería el protocolo). `initialize`
hace eco del `protocolVersion` pedido si está soportado (`2024-11-05`);
si no, responde el máximo soportado. Ciclo de vida: `SIGINT` sólo
trunca la operación activa (es la señal del `stop` cross-process y no
termina el proceso); `SIGTERM` trunca y termina, con gracia de 250 ms
para asentar el truncado en curso — la salida es la NATURAL del
proceso si ésta se adelanta (p. ej. EOF de stdin del orquestador), o
`exit 143` si decide la gracia.

Tools: speak(text, engine?), listen(timeout_s?), stop(), session_new(template_id?),
list_engines(), get_config() — matriz SANEADA: disponibilidad, selección
y constraints, sin rutas del filesystem —, list_templates() — incluye
turns —, validate(session, text). Mismos códigos de error que CLI; un
`listen` interrumpido por `stop` se resuelve con `stopped`. `validate`
recibe la sesión inline como objeto.
Los errores de operación MCP viajan como JSON `{ "error": "<código>" }`
en `content[0].text`; los errores JSON-RPC son sólo de protocolo.
`speak` y `listen` incluyen `duration_ms` entero no negativo aun cuando
fallen o sean interrumpidos. `channel_busy` puede incluir `busy_pid`
diagnóstico. `causa` de audio es opcional y de lista cerrada según el
contrato de consumo §5.

## CONTRATO: plantilla v1 (esquema cerrado)

Claves permitidas: id (`^[a-z0-9-]{1,64}$`), kind (free|structured),
proposed_by (agent|orchestrator|builtin), description?, turns[]. Turno:
expectation (exact|regex — intent-free excluida), pattern? (≤200 chars,
solo si regex), objections? ([str ≤200]).

Canonización de texto: NFC → strip de inaudibles (U+200B–D, BOM/FEFF,
bidi U+202A–E, controles) → límite 2000 chars → match.

Dialecto regex v1 (lineal, sin retroceso catastrófico): prohibidos
backreferences, lookaround, `{n,}` abierto, cuantificadores dobles,
cuantificador sobre grupo que contiene cuantificador. Match anclado
`^(?:...)$`, case-insensitive.

## CONTRATO: sesión efímera v1

`{schema: glosomata/sesion-v1, id: uuid-v4, template|null, turn: Nat≥0,
created_at: ISO-8601, ttl_min}` — `ttl_min` al acuñar viene de
`constraints.session_ttl_min` de la matriz (15 si falta; malformado →
`config_unreadable`, no default oculto). La posee el agente. Expirada si
`now - created_at > ttl_min*60s`, si `created_at` es ilegible, o si
`ttl_min` no es numérico finito ≥ 0 (fail-closed, sin coerción de
strings). `validate` verifica además la FORMA v1 antes de expiración y
turno: objeto plano con `schema` exacto `glosomata/sesion-v1` — sesión
sin forma → `session_invalid`.

## CONTRATO: matriz de configuración v1

`glosomata.json` (ruta override: GLOSOMATA_CONFIG): engines.tts[]
{id, adapter, selected, kill_switch{type,target,max_latency_ms},
bin?/model?/python?/script?/voice?/rate?/pitch_scale?/sample_rate?} —
para el adaptador kokoro `model` es obligatorio en la práctica: el
probe lo declara no disponible si falta (fail-closed,
`modelo_ausente`) y el script de síntesis lo exige —
`from_pretrained` sin él descargaría de HuggingFace (prohibido: 100%
local); el schema común de motor no expresa el condicional (nota en
el propio schema). engines.stt {whisper_bin?, whisper_model?} —
sin claves el STT queda no disponible (fail-closed), el TTS sigue.
constraints {validation_floor_ms*, confirmation_channels*,
session_ttl_min, max_text_chars, max_pattern_chars*,
listen_default_timeout_s} — (*) sin lector en src/, deprecadas en el
schema; `max_pattern_chars` duplica el límite duro 200 de §plantilla.
Referencia formal con rangos:
`docs/schemas/glosomata-config-v1.schema.json` (ADR-008); `matriz.mjs`
sigue siendo la autoridad en runtime. `max_text_chars`: tope duro 2000
(la unificación de superficies se ejecuta en P1.3). Config sin
engines.tts[] o engines.stt → `config_unreadable` (fail-closed
estructural). Motor sin kill_switch declarado → no seleccionable
(fail-closed). Selección apunta sólo a available=true.

## Máquina de estados (por invocación)

idle → speaking → done | failed → cleanup → idle (speak);
idle → listening → validating → done|failed → cleanup → idle (listen).
Timeout → failed explícito, nunca éxito inferido. Objection → el
agente repite el turno según su propia política (mismo turno, sin
contador en el núcleo); session_abandoned lo emite el agente, no
glosomata (ADR-001).

## No objetivos v1 (declarados)

Streaming de audio; cola/prioridad de turnos (REQ-12 pospuesto a v2);
expectation intent-free; servidor HTTP/socket; WAV externo como entrada
(listen captura del micrófono, 16 kHz mono PCM interno); multiusuario;
VAD/barge-in (candidato v1.1 con ADR propio).
