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
`glosomata speak` con la matriz Jarvis. La copia versionada registra el
código de salida del subprocess; un turno de OpenCode terminado no prueba
por sí solo que se haya reproducido audio. La copia versionada envía la
locución por stdin con `--text-stdin`. La copia global instalada aún no se
ha actualizado y sigue pasando el texto por `argv`: no usarla para
contenido sensible hasta instalar y verificar la corrección.
