# Timbre de Jarvis para OpenCode

`timbre-jarvis.js` es la copia versionada del plugin global de OpenCode
instalado en `~/.config/opencode/plugins/timbre-jarvis.js` el 2026-11-07.
OpenCode carga la copia global; este directorio conserva el código revisable.
La instalación o actualización global es una acción separada.

El plugin invoca `src/cli.mjs speak --engine phonon-rebeca` con
`GLOSOMATA_CONFIG` apuntando a `glosomata.jarvis.json`. Requiere el alias
local de Ollama `phonon-es-mx-eval-20261027:latest` con la voz `Rebeca`.
La matriz ordinaria `glosomata.json` mantiene su selección propia.

Verificación acotada: `node --check integrations/opencode/timbre-jarvis.js`,
comparación de bytes con la copia instalada y prueba directa de
`glosomata speak` con la matriz Jarvis. El plugin no observa el resultado
del subprocess, por lo que un turno de OpenCode terminado no prueba que
se haya reproducido audio. El texto de locución pasa por `argv`; no usar
esta integración para contenido sensible hasta corregir ese flujo.
