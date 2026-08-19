# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/es-1.1.0/),
versionado [SemVer](https://semver.org/lang/es/). Notas por release
generadas desde commits/PRs reales.

## [Unreleased]

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
