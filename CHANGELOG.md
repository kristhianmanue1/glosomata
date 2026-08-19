# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/es-1.1.0/),
versionado [SemVer](https://semver.org/lang/es/). Notas por release
generadas desde commits/PRs reales.

## [Unreleased]

- fix: MCP — errores JSON-RPC estándar (`-32601` método desconocido,
  `-32700` parse, `-32600` envelope, `-32602` params; antes colgaban al
  cliente o mataban el servidor), `ping`, escritura con reintento;
  tests MCP 2→15 (PR #2).
- docs: guía de consumo MCP (`docs/guia-mcp.md`), spec corregida
  (`session_abandoned` lo aplica el agente, no el núcleo — ADR-001),
  archivos de comunidad, licencia visible en README y `package.json`.

## [0.1.0-alpha.2] — 2026-08-18

- fix: ronda adversarial 3 — 3 BLOCKER, 5 HIGH y MEDs cerrados, incluye
  escáner regex tokenizado (bypasses ReDoS reproducidos y cerrados) y
  contaminación del protocolo MCP desde operaciones.
- feat: captura de audio ALSA en Linux con fail-closed en el resto.
- fix: inputSchemas MCP cerrados (`additionalProperties: false`) y
  rangos de `timeout_s` alineados con la validación interna.

## [0.1.0-alpha.1] — 2026-08-17

- Primer cascarón verificable: F0–F2 del método Skevi (PR #1).
- Canal half-duplex con lockfile atómico, temporales 0700 y kill-switch
  cross-process; sesión efímera; plantillas v1 con dialecto regex lineal;
  CLI completa; servidor MCP stdio; suite de contratos.
- Verificación física: 3 motores TTS reales, STT whisper.cpp, WER
  español 4/4, kill-switch 38–55 ms.

[Unreleased]: https://github.com/kristhianmanue1/glosomata/compare/v0.1.0-alpha.2...HEAD
[0.1.0-alpha.2]: https://github.com/kristhianmanue1/glosomata/compare/v0.1.0-alpha.1...v0.1.0-alpha.2
[0.1.0-alpha.1]: https://github.com/kristhianmanue1/glosomata/releases/tag/v0.1.0-alpha.1
