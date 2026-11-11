# Contrato de hardware — v1 (inventario de dispositivos)

> **Estado:** PROPUESTA. Pasa a normativo con su aceptación explícita y
> ronda adversarial. Modelo y vocabulario:
> `docs/specs/contrato-consumo-agentes-v1.md`; la taxonomía de errores
> sigue mandando en `docs/specs/specs-y-contratos-v1.md`.

## 1. Alcance

Inventario de dispositivos de audio del **HOST LOCAL** donde corre
glosomata, en **sólo lectura**: ninguna operación de este contrato abre
micrófono, reproduce audio ni toma el canal (`canal.lock` no se toca).
Fuentes del listado, consultadas en paralelo:

1. **ffmpeg** (`-hide_banner -f avfoundation -list_devices true -i ""`,
   binario por `rutaFfmpeg()`): entradas de audio según avfoundation,
   con el índice de backend que glosomata usaría para capturar.
2. **system_profiler** (`SPAudioDataType -json`): flags de default del
   SO. Reporta el dispositivo de SALIDA por defecto y el de ENTRADA por
   defecto del sistema operativo; el resto del catálogo de
   system_profiler no pertenece a v1 (la salida no es seleccionable, §4).

## 2. Forma de respuesta (exit 0)

```json
{
  "devices": [
    { "kind": "input", "id": "0", "name": "...", "source": "ffmpeg",
      "is_default_glosomata": true },
    { "kind": "input", "id": "1", "name": "...", "source": "ffmpeg",
      "is_default_so": true },
    { "kind": "input", "id": null, "name": "...", "source": "system",
      "is_default_so": true },
    { "kind": "output", "id": null, "name": "...", "source": "system",
      "is_default_so": true }
  ],
  "platform": "darwin",
  "captured_at": "2026-11-11T00:00:00.000Z",
  "limits": { "id_estable": false, "seleccion_salida": false },
  "degraded": ["system_profiler"]
}
```

Semántica de cada campo:

- `devices[].kind`: `input` capturable | `output` reproducible.
- `devices[].id`: índice de backend **sólo para `source:"ffmpeg"`**
  (el que `-i :N` usaría en captura); `null` para `source:"system"`,
  que no expone índice. Ver §4 (ids NO estables).
- `devices[].name`: nombre del dispositivo tal como lo reporta la
  fuente. No canonizado, no único (homónimos posibles).
- `devices[].source`: `"ffmpeg"` (enumeración de entradas del backend
  de captura) | `"system"` (defaults del SO).
- `devices[].is_default_glosomata`: `true` en la entrada ffmpeg con
  `id === "0"` — el dispositivo que la captura STT usaría hoy.
- `devices[].is_default_so`: `true` en el dispositivo que el SO tiene
  como default de entrada o de salida; en entradas ffmpeg aparece como
  campo EXTRA sólo cuando el nombre coincide con el default de entrada
  del SO (match por nombre, best-effort: homónimos quedan todos
  marcados, §4). Añadir campos es compatible (§2 del contrato de
  consumo); los listados aquí nunca se renombran ni se eliminan.
- `platform`: SO del host inventariado (hoy sólo `"darwin"`).
- `captured_at`: marca de tiempo ISO-8601 del momento del listado.
- `limits`: constantes contractuales de v1: `id_estable:false` (los
  índices no sobreviven reinicios ni reconfiguración) y
  `seleccion_salida:false` (no hay selección de dispositivo de salida).
- `degraded` (opcional): fuenteS caídaS cuando UNA falló pero la otra
  listó — degradación honesta: se entrega lo listado nombrando la
  fuente ausente. Valores del conjunto cerrado: `"ffmpeg"`,
  `"system_profiler"`. Ausente = ambas fuentes respondieron.

## 3. Fallos explícitos

Exit 1 con `{error: "devices_unavailable", causa}` por CLI/stderr y por
MCP como error de operación (`isError:true`). `causa` pertenece al
conjunto cerrado:

| `causa` | Significado exacto |
|---|---|
| `plataforma_no_soportada` | El host no es darwin: no hay backend avfoundation que inventariar. No afirma nada sobre dispositivos. |
| `ffmpeg_ausente` | El binario ffmpeg no pudo ejecutarse (ausente o intocable). |
| `listado_ilegible` | Las fuentes corrieron pero ningún listado fue legible (sección de audio ausente, JSON roto, tope de tiempo). |

Reglas fail-closed:

- **Jamás se infiere permiso o ausencia de dispositivo de un exit
  genérico.** `ffmpeg -list_devices` termina con exit I/O error DESPUÉS
  de listar (observado en darwin): el parser decide por CONTENIDO, no
  por exit. Un exit ≠ 0 con listado legible es exit 0 con datos.
- Un `listado_ilegible` no distingue "sin dispositivos" de "no pude
  leer": reporta exactamente eso, sin especular.
- En fallo total (ambas fuentes caídas) la precedencia de `causa` es:
  `ffmpeg_ausente` si el binario no corrió; si no, `listado_ilegible`.
- Un timeout (10 s por fuente) cuenta como fuente caída: degrada o,
  en fallo total, produce `listado_ilegible`.

## 4. Límites declarados

1. **Ids de backend NO estables**: los índices avfoundation no son
   identidad de dispositivo; pueden cambiar entre reinicios, reconexión
   de hardware o cambios de configuración del SO. Quien persista un id
   lo hace bajo su propio riesgo; re-listar antes de usar.
2. **Default del SO ≠ default usado**: `is_default_so` (elección del
   usuario en el SO) y `is_default_glosomata` (índice 0 de avfoundation)
   se reportan por separado y PUEDEN diferir. Ninguno de los dos
   garantiza el dispositivo de una captura futura si el SO reordena
   índices.
3. **Salida NO seleccionable**: v1 no cambia el dispositivo de salida;
   la reproducción usa el default del SO. (`afplay -d` es flag de
   debug, no una superficie de selección contratada.)
4. **Residual de homónimos en el match por nombre**: el marcaje
   `is_default_so` sobre entradas ffmpeg compara NOMBRES; dos
   dispositivos con el mismo nombre quedan ambos marcados. El caso se
   declara, no se resuelve, en v1.

## 5. No-retención

El inventario conserva (en la respuesta): ids, nombres, flags y marca
de tiempo. JAMÁS audio, texto de usuario, transcripción ni contenido de
ningún dispositivo. La sonda no abre dispositivos: `-list_devices` de
ffmpeg y `system_profiler SPAudioDataType -json` son consultas de
enumeración que no capturan ni reproducen nada.

## 6. Variables de entorno

| Variable | Efecto | Consumidor típico |
|---|---|---|
| `GLOSOMATA_SYSTEM_PROFILER` | ruta del binario system_profiler usada por `devices` (default `/usr/sbin/system_profiler`) | tests herméticos |

`GLOSOMATA_FFMPEG` (contrato de consumo §6) rige también aquí: el
inventario usa el MISMO `rutaFfmpeg()` que la captura STT.

## 7. Superficies de acceso

- **CLI**: `glosomata devices` — JSON por stdout; exit 0/1 como §2/§3.
  Superficie NUEVA ESTRICTA: no acepta argumento ni flag alguno;
  cualquier extra → exit 2 `usage` (no hereda la tolerancia legacy).
- **MCP**: tool `devices` (9ª) sin parámetros
  (`properties:{}`, `additionalProperties:false`); misma forma saneada
  que el CLI; llamada con campos espurios rechazada fail-closed.

## 8. Frontera de migración

Si glosomata migrara a servidor, los dispositivos que el servidor
enumera NO son necesariamente el hardware del Operador: el inventario
pertenece al **host que captura y reproduce**. Ante esa migración este
contrato debe identificar el host de audio (p. ej. campo `host`
contratado) antes de que un consumidor remoto pueda interpretar el
listado como "mi hardware". Mientras no exista ese campo, la respuesta
sólo tiene sentido leída EN el host que la produjo.

## 9. Lo que v1 NO ofrece

Pacto de no sorpresa (los no-objetivos del contrato de consumo §2
siguen vigentes): sin `--device`, sin semántica de mute, sin cambio de
dispositivo de salida, sin cola de turnos, sin servidor, sin hot-swap
de dispositivos, sin retención de audio. Cualquier apertura requiere
decisión humana y ADR propios.

## 10. Historia

- v1 (2026-11-11): propuesta inicial (G0+G1) — inventario local de
  sólo lectura con dos fuentes (ffmpeg avfoundation + system_profiler),
  degradación honesta por fuente, código `devices_unavailable` con
  causas cerradas y variable `GLOSOMATA_SYSTEM_PROFILER`.
