# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/es-1.1.0/),
versionado [SemVer](https://semver.org/lang/es/). Notas por release
generadas desde commits/PRs reales.

## [Unreleased]

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
