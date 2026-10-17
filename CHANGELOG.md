# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/es-1.1.0/),
versionado [SemVer](https://semver.org/lang/es/). Notas por release
generadas desde commits/PRs reales.

## [Unreleased]

- feat: **`config set <archivo-json>`** (P1.2, ADR-008) — replace
  atómico de la matriz completa: candidato a temporal 0600 en el
  directorio del destino, validación completa sobre el temporal
  (schema + semántica + probes), backup previo junto al lock del
  canal (retención: últimas 5) y `rename`. Cualquier fallo →
  `config_write_failed` con el veredicto y el original intacto; el
  schema garantiza que jamás se persistan campos derivados. Semántica
  nueva compartida por `config validate`: ids únicos en engines.tts y
  exactamente un motor `selected:true` (el schema no puede
  expresarlo). Criterio: jamás queda una config rota tras un set.
- feat: **`config validate [--file <ruta>]`** (P1.3) — veredicto
  estilo `doctor`: estructura contra el schema formal (P0.2) + probes
  + kill_switch sobre la MISMA ruta que usará `config set`; JSON por
  stdout, stderr vacío, exit 0 sólo si todo lo declarado pasa (stt
  sin claves declaradas es no-disponible fail-closed, no config
  rota). Validador draft-07 promovido de tests a `src/schema.mjs`
  (runtime de estructura; probes siguen en `matriz.mjs`).
  `--file` juzga una candidata sin tocar la real. Criterio: validar
  antes de escribir es un comando, no una fe.
- feat: **`config list` y `config get <sección>`** (P1.1) — lectura
  CRUDA de la matriz por CLI (JSON tal cual en disco, sin probes ni
  campos derivados; la sección es lista cerrada
  `engines|constraints`, sin traversal — misma regla que
  `templates --show`). Criterio: un agente lee la config sin tocar
  el archivo. Spec §CLI v1, contrato §1 (10 comandos) y §3, README
  §Comandos en el mismo commit.
- feat: **schema formal de `glosomata.json`** (P0.2, ADR-008):
  `docs/schemas/glosomata-config-v1.schema.json`, cerrado contra el
  código — incorpora `script`/`rate`/`sample_rate` que el spec §matriz
  omitía; rangos nuevos con dientes (`rate` 50–500, `pitch_scale`
  0.8–1.2 declarados a tiempo de config — antes tarde y opacos en
  playback, `max_text_chars` tope duro 2000 — unificación P1.3),
  enums y piso de `kill_switch`, claves sin lector marcadas
  `deprecated` (anotación que no rechaza). Validador mínimo de
  draft-07 en tests (repo cero-dependencias) con controles positivos
  (example, config real del operador, config que ejerce TODAS las
  claves opcionales) y negativos (once rechazos) + vigilancia meta:
  el schema sólo usa palabras clave que el validador implementa.
  Ronda adversarial absorbida: schemas booleanos (true/false) y
  `items` tupla manejados fail-closed en el validador (antes puntos
  ciegos silenciosos), pattern sin flag (ECMA-262 como draft-07), y
  notas de `model` kokoro (exigido por el probe, no expresable como
  condicional) y `sample_rate` (debe coincidir con la tasa del
  modelo piper — sólo rotula el header WAV) en schema y spec.
- docs: alta de `config_write_failed` en la taxonomía cerrada (P0.3)
  — spec §CLI v1 y contrato §2.1: 17 originales + 1. Destinado a los
  fallos de la escritura gobernada de config (`config set`, P1.2);
  la taxonomía sólo crece.
- docs: **ADR-008 (configuración gobernada) ACEPTADO** — decisión
  humana explícita del operador (2026-10-17). P0.1 del plan v4
  ejecutado; sin barrido de docs: los no-objetivos siguen siendo
  verdad literal. Siguiente tarea del plan: P0.3 (alta de
  `config_write_failed` en spec §CLI v1 y contrato §2.1).
- docs: **cambio de alcance del plan de playground (v4, decisión del
  operador)** — el servidor HTTP, la UI y el selftest (P3–P5) migran a
  un proyecto aparte que consume glosomata por superficies
  contratadas (CLI/MCP); hogar por decidir. ADR-008 reescrito como
  «configuración gobernada» (renombrado; sin reapertura HTTP): el
  no-objetivo «sin servidor HTTP/socket» queda intacto y ningún
  documento canónico necesita barrido — el P0.1 de la v1 queda sin
  objeto. El plan reduce su alcance vigente a P0–P2; P3–P5 se
  conservan como especificación semilla para el plan del proyecto
  nuevo (la dependencia C2.5→serve migra con él).
- docs: plan de playground v3 — absorbe el análisis contra código
  2026-10-17: premisa de `pitch_scale` corregida (el rango 0.8–1.2 ya
  se aplica en el script, tarde y opaco), unificación de
  `max_text_chars` (H1) decidida en P0.2 y ejecutada en P1.3, enums y
  piso de `kill_switch`, endgame de las claves deprecated (remover, no
  cablear), forma exacta de `get_config` saneada (P2.1), precisiones
  de implementación de `serve` (P3.1: stdout contractual, `Host` sin
  puerto, self-SIGINT de `/stop`), rechazo de ids duplicados y
  política de `selected` en `config set` (P1.2), orden C2.5→P3.2 y
  decisión doctor todos-vs-≥1 antes de P5.1.
- docs: contrato de consumo §10 honesto — el `max_latency_ms` se
  declara, no se evalúa (el corte real es SIGKILL al grupo con poll de
  ~50 ms); antes prometía una latencia máxima verificada.
- ci: workflow de integración (`ci.yml`) — suite `node --test` en Node
  20 (mínimo contratado) y 24 (verificado) + gate de estructura
  `check_sizes.py` en cada PR y push a main. La verificación previa de
  los planes deja de depender de la disciplina manual del agente.
  Primera captura: skip de darwin sin `return` en ronda5 seguía
  corriendo el cuerpo en Node 20/Linux y envenenaba el exit del runner
  (Node ≥24 aborta el cuerpo en `t.skip`; el 20 no) — corregido al
  patrón `return t.skip` del resto de la suite.
- fix: SIGTERM termina el proceso — el handler sustituía la
  terminación por defecto y el servidor MCP sobrevivía a su propio
  shutdown. Trunca (flag + kill de grupos) con gracia de 250 ms: la
  salida es la NATURAL del proceso si se adelanta (p. ej. EOF de
  stdin), o `exit 143` si decide la gracia; en el CLI, el exit
  natural (truncado asentado) o 143. `SIGINT` conserva la semántica
  de sólo truncar: es la señal del `stop` cross-process (H2 del
  análisis previo al plan de playground; tests de señales por proceso
  real, `tests/canal.test.mjs`; ronda adversarial absorbida: salida
  natural vs 143 declarada en spec §CLI y §MCP, tests con limpieza y
  tope de espera).
- feat: negociación de `protocolVersion` en `initialize` — eco de la
  versión pedida si está soportada (`2024-11-05`), máximo soportado si
  no (C1.4; cierra el incremento C1 del plan de consumo).
- fix: forma de sesión v1 verificada en validate CLI y MCP — `schema`
  exacto obligatorio, objeto plano (JSON `null` ya no explota con
  TypeError fuera de taxonomía) y `ttl_min` malformado fail-closed
  (antes `'para_siempre'` comparaba contra NaN y la sesión nunca
  expiraba) (C1.3).
- fix: sesión acuñada sin plantilla (`template:null`) es modo libre —
  `validate` responde ok siempre (SPEC-2); antes `template_invalid`.
  El contador de turno se valida antes que la plantilla (C1.5).
- feat: MCP-only de primera clase (C1.1/C1.2) — tool `session_new`
  (misma acuñación que el CLI, TTL desde constraints) y
  `list_templates` con `turns`; un agente que sólo habla MCP completa
  un turno sin tocar el CLI.
- feat: `doctor` en CLI — diagnóstico de instalación con causas cerradas
  (node, config, motores TTS con `diagnostico()` por adaptador, whisper
  bin/model, ffmpeg por plataforma); `matriz` adjunta causa cerrada a
  cada motor no disponible y rechaza entradas no-objeto en `tts[]`;
  `disponible()` queda como envoltura de `diagnostico()`; helpers
  compartidos `rutaFfmpeg()`/`diagnosticoCaptura()`/`diagnosticoWhisper()`
  (una sola definición para listen/engines/doctor). Forma y conjunto
  cerrado de causas en contrato de consumo §7.1 (C0.2 del plan).
- docs: variables de entorno contractuales (`GLOSOMATA_CONFIG`,
  `GLOSOMATA_RUNTIME`, `GLOSOMATA_FFMPEG`) documentadas en la guía MCP y
  README (C0.3 del plan de consumo).
- feat: `version` en CLI y `serverInfo.version` del servidor MCP leídos
  de `package.json` — fuente única de versión, sin hardcode ni drift
  (C0.1 del plan de consumo).
- fix: ronda adversarial 5 — RMS de silencio sobre WAV real (el header de
  ffmpeg escribe `data` en offset 70, no 44: `mic_timeout` nunca disparaba
  con silencio real); guard de stop en la captura STT (reportaba
  `mic_denied` en vez de `stopped` ~5% de las veces); robo del lock
  atómico con `rename` (3 procesos podían dejar dos holders); kokoro
  exige `model` local (sin él, `from_pretrained` descargaba de red);
  config sin `engines` → `config_unreadable` (antes TypeError fuera de
  taxonomía); texto legítimo que inicia con `--` rechazado como `usage`
  falso vía MCP; probes honestos (piper/kokoro/say verifican plataforma y
  binario); TTL de sesión desde `constraints.session_ttl_min`; EPIPE de
  stdout MCP termina limpio; `list_engines` no expone rutas del STT.
- fix: MCP — errores JSON-RPC estándar (`-32601` método desconocido,
  `-32700` parse, `-32600` envelope, `-32602` params; antes colgaban al
  cliente o mataban el servidor), `ping`, escritura con reintento;
  tests MCP 2→15 (PR #2).
- docs: guía de consumo MCP (`docs/guia-mcp.md`), spec corregida
  (`session_abandoned` lo aplica el agente, no el núcleo — ADR-001;
  taxonomía completa con `audio_device_error`; semántica real de
  `listen`), archivos de comunidad, licencia visible en README y
  `package.json` (PR #3, tras ronda adversarial).

## [0.1.0-alpha.2] — 2026-08-18

- fix: escáner regex tokenizado — cierra bypass de ReDoS (`)` en clase
  de caracteres) y cadenas de cuantificadores; fuzz 20000 sin hallazgos.
- fix: inputSchemas MCP cerrados (`additionalProperties: false`) y
  rangos de `timeout_s` alineados con la validación interna.
- feat: captura de audio ALSA en Linux con fail-closed en el resto.

## [0.1.0-alpha.1] — 2026-08-17

- Cascarón verificable completo: F0–F3 (PR #1) — canal half-duplex con
  lockfile atómico, temporales 0700 y kill-switch cross-process; sesión
  efímera; plantillas v1 con dialecto regex lineal; CLI completa;
  servidor MCP stdio; motores TTS reales (say, Piper, Kokoro MLX) y STT
  whisper.cpp; suite de contratos.
- fix: ronda adversarial 3 sobre la implementación — 3 BLOCKER, 5 HIGH
  y MEDs cerrados (TOCTOU del lock, contaminación del protocolo MCP
  desde operaciones, drenaje de stderr en subprocesses).

[Unreleased]: https://github.com/kristhianmanue1/glosomata/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/kristhianmanue1/glosomata/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/kristhianmanue1/glosomata/releases/tag/v0.1.0-alpha.1
