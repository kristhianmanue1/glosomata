# Especificaciones y contratos v1 (F1, revisados tras ronda adversarial 2)

## SPEC-1: turno de voz (REQ-1, 3, 5, 9–12)

Comportamiento: `speak` reproduce texto por el motor seleccionado y
devuelve `{played, engine, echo, truncated}` — `echo` = texto
canonicalizado, sólo con reproducción completa; `played:false` ante
cualquier interrupción. `listen` bloquea hasta voz o timeout y devuelve
transcripción.

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

Invariantes: 100% local; temporales unlink-tras-open en dir 0700 per-user
con barrido por edad; logs sólo ids/códigos/duraciones, JAMÁS texto,
patrón, transcripción ni echo; logs MCP a stderr.

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
templates [--list|--show id]; session new [--template id]; validate
--session archivo --text str.

Exit codes: 0 ok; 1 error (código en stderr); 2 usage.

Errores (taxonomía cerrada): engine_unavailable, tts_failed, stt_failed,
mic_denied, mic_timeout, template_invalid, not_found, text_too_long,
session_invalid, session_expired, session_abandoned, channel_busy,
not_supported, config_unreadable, usage, internal_error.

## CONTRATO: MCP v1

Transporte: stdio únicamente, heredado del orquestador. Sin socket/HTTP.
Logs a stderr, jamás stdout (corrompería el protocolo).

Tools: speak(text, engine?), listen(timeout_s?), stop(), list_engines(),
list_templates(), validate(session, text). Mismos códigos de error que
CLI. `validate` recibe la sesión inline como objeto.

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
created_at: ISO-8601, ttl_min: default 15}`. La posee el agente. Expirada
si `now - created_at > ttl_min*60s` o created_at ilegible (fail-closed).

## CONTRATO: matriz de configuración v1

`glosomata.json` (ruta override: GLOSOMATA_CONFIG): engines.tts[]
{id, adapter, selected, kill_switch{type,target,max_latency_ms},
bin?/model?/python?/voice?/pitch_scale?}, engines.stt {whisper_bin,
whisper_model}, constraints {validation_floor_ms, confirmation_channels,
session_ttl_min, max_text_chars, max_pattern_chars,
listen_default_timeout_s}. Motor sin kill_switch declarado → no
seleccionable (fail-closed). Selección apunta sólo a available=true.

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
