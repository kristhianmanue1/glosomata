# Seguridad

## Modelo

glosomata es un canal de voz **100% local**: sin APIs de terceros, sin
telemetría, sin persistencia de audio, texto ni transcripciones más allá
del proceso. Los temporales son unlink-tras-open en directorio 0700 por
usuario y se barren por edad (`src/canal.mjs`).

Propiedades declaradas (no negociables en PRs):

- **Sin retención**: lo que pasa por el canal no se guarda ni se loguea.
  Los logs llevan ids, códigos y duraciones — nunca texto del usuario.
- **Fail-closed**: motor sin `kill_switch` declarado no es seleccionable;
  sesión corrupta o expirada → error explícito, nunca éxito inferido.
- **Frontera GPL**: Piper corre como subprocess con texto por stdin;
  prohibido link dinámico y bundling (ADR-005).
- **Superficie mínima**: MCP escucha stdio heredado del orquestador; sin
  socket, sin HTTP.

El texto pasa por subprocesses locales (`say`, `piper`, `python`+Kokoro,
`whisper-cli`, `ffmpeg`). El modelo de amenaza asume máquina de un solo
usuario: no hay aislamiento entre procesos del mismo usuario.

## Reportar una vulnerabilidad

Abre un **Security Advisory privado** en este repo (GitHub → Security →
Report a vulnerability), no un issue público. Incluye reproducción y
versión/commit. Si afecta la política de no-retención o la frontera GPL,
márcalo explícitamente.
