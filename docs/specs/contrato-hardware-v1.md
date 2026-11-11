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

**Ampliación G2 (2026-11-11)**: este contrato añade la semántica de
selección de ENTRADA por nombre exacto (§3.1 y §10), la preferencia
externa por defecto (§11), la posición sobre mute (§12) y la frontera
de integración con el consumidor de voz (§13). La ampliación consume el
listado ffmpeg en sólo lectura; la CAPTURA sigue contratada por la
superficie `listen` (specs §CLI), y el inventario `devices` no cambia.

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

### 3.1 Selección de entrada por nombre — flujo y sus tres fallos

`listen` acepta una selección de ENTRADA por nombre exacto (`--device`
en CLI, campo `device` en MCP; semántica completa en §10). Cuando hay
petición —explícita o preferencia implícita (§11)— el flujo es:
validación de FORMA → sonda `-list_devices` (SÓLO ffmpeg; jamás
`system_profiler`) → validación 0/1/N → captura. Son tres fallos
DISTINTOS y el consumidor no debe confundirlos:

| Fallo | Respuesta exacta | Qué afirma y qué no |
|---|---|---|
| **Listado ilegible** (la sonda no corrió o el listado no fue legible) | `audio_device_error` con `causa:"device_list_unavailable"` | «No pude verificar el inventario para validar tu selección.» NI afirma que el dispositivo falte (`device_missing`), NI que la captura fallara (`capture_failed`). Fail-closed: no se abre micrófono y el ffmpeg de CAPTURA no se invoca para nada. |
| **Ausente o ambiguo** (0 o >1 coincidencias exactas en el listado fresco) | `audio_device_error` con `causa:"device_missing"` | «El inventario fresco no muestra exactamente una entrada con ese nombre.» El detalle de nombres disponibles viaja SOLO por CLI (canal local del Operador); MCP jamás lo lleva (privacidad). Los homónimos reportan «nombre ambiguo: N coincidencias» (sin nombres). Tampoco se abre micrófono. |
| **Captura rota** (el dispositivo desapareció o fue renombrado ENTRE la validación y la apertura) | `audio_device_error` con `causa:"capture_failed"` | ffmpeg falló RUIDOSO al abrir el nombre pedido: el fallo es audible, nunca «otro micrófono en silencio». |

Reglas innegociables del flujo:

- **La validación 0/1/N es previa e innegociable**: jamás se captura
  por nombre sin chequeo de homónimos contra el listado fresco.
- **JAMÁS fallback a `:0`** cuando hay petición — ni en el listado
  ilegible, ni en la ausencia, ni en la ambigüedad. El id numérico del
  listado JAMÁS viaja a ffmpeg (sólo diagnóstico).
- La sonda de listado es la misma fuente ffmpeg del inventario y corre
  FUERA del canal (sólo lectura, sin `canal.lock`).

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
siguen vigentes): sin selección de dispositivo de SALIDA, sin semántica
de mute (§12), sin cola de turnos, sin servidor, sin hot-swap de
dispositivos DURANTE una captura, sin retención de audio. La selección
de ENTRADA por nombre (§10) y la preferencia externa (§11) SÍ son
parte de v1 desde la ampliación G2 (2026-11-11). Cualquier otra
apertura requiere decisión humana y ADR propios.

## 10. Selección de entrada por nombre exacto (G2a)

`listen` acepta `--device "<nombre-exacto>"` (CLI) y el campo opcional
`device` (string) en la tool MCP `listen`, en el MISMO commit que este
texto. Semántica:

1. **Binding por NOMBRE, jamás por índice.** El selector que viaja a
   ffmpeg es `:<nombre-exacto>` (`-i "[V]:[A]"` acepta nombre o índice;
   el nombre lo resuelve AVFoundation AL ABRIR, dentro del mismo
   proceso ffmpeg — no existe hueco listado→captura en nuestra
   tubería). La selección por ÍNDICE está RECHAZADA: entre el listado
   y la captura el índice puede REORDENARSE y apuntar a OTRO
   micrófono VÁLIDO — la captura «tiene éxito» en el dispositivo
   equivocado, en silencio. No es fail-closed para privacidad. El id
   numérico del listado es sólo diagnóstico.
2. **Forma (fail-closed antes de abrir, `usage`/exit 2)**: nombre
   vacío, que contenga `:` o comillas (rompen la sintaxis
   `-i "[V]:[A]"`), o que sea EXACTAMENTE un alias reservado del
   backend (`default`/`none`, indistinguible de los alias según docs
   oficiales). Un dispositivo que SÓLO pueda nombrarse así no es
   seleccionable por nombre: se rechaza, no se adivina. La MISMA regla
   gobierna `config validate` para la preferencia (§11).
3. **Validación 0/1/N** contra el listado ffmpeg fresco, antes de
   abrir (§3.1): 0 coincidencias → `device_missing` (+ nombres
   disponibles, sólo CLI); >1 homónimos → `device_missing` con
   «nombre ambiguo: N coincidencias», fail-closed, sin adivinar.
4. **Plataformas sin la selección**: fuera de darwin la petición
   responde `not_supported` (código existente; sin códigos nuevos).
   Sin petición, la conducta original (`:0` en darwin, alsa default en
   linux) queda INTACTA.
5. **Precedencia**: `--device` (petición explícita) > preferencia de
   matriz (§11) > `:0`.

Residuales declarados SIN atenuación:

- **El nombre NO es identidad estable.** Dos micrófonos FÍSICOS
  distintos pueden compartir nombre exacto. Si un homónimo aparece
  DESPUÉS de la validación y antes de la apertura, ffmpeg elige entre
  ellos y glosomata no puede observarlo ni impedirlo: el fail-closed
  cubre homónimos OBSERVADOS en el listado de validación, NO ofrece
  garantía absoluta ante hotplug posterior.
- **Intercambio físico de hardware que conserva el nombre**: la
  ambigüedad es la misma y NO es detectable por glosomata — sin
  identidad estable no hay garantía, sólo fallo ruidoso ante lo
  observado.
- **UID bloqueado en esta build**: `-audio_device_id uid:<UID>` está
  documentado upstream pero la build instalada (ffmpeg 8.1.1) no lo
  expone (verificado `-h demuxer=avfoundation`: sólo
  `-audio_device_index`). Sin UID no existe prevención absoluta de
  dispositivo equivocado; el UID sigue siendo el único camino a esa
  garantía (camino documentado de mejora).
- **Exposición del nombre en argv**: el nombre del dispositivo viaja
  en el argv de ffmpeg y queda visible en la lista de procesos local
  mientras viva el proceso (segundos). Los nombres de hardware pueden
  contener identificadores personales. Los LOGS de glosomata siguen
  sin contenido (ids/códigos/duraciones), pero el argv es exposición
  real declarada; no hay alternativa conocida en esta build para
  pasar el selector fuera de argv (precedente interno:
  `speak --text-stdin` existe por esto; para el selector avfoundation
  no hay equivalente).
- **Binding físico NO verificado (`inconclusive`)**: la prueba
  hermética cubre la TUBERÍA (argv con `:nombre`, jamás índice;
  validación 0/1/N/alias). Que el nombre se liga FÍSICAMENTE al
  dispositivo esperado dentro de AVFoundation exige ensayo vivo con el
  Operador (listado → preferencia correcta → nombre inexistente →
  homónimo → renombre en caliente → verificación de origen del audio).
  Hasta entonces, binding físico = inconclusive.

## 11. Preferencia externa por defecto (G2a2)

El Operador puede fijar un dispositivo de ENTRADA por defecto. Reglas:

1. **Dónde vive (privacidad primero)**: el schema admite
   `engines.stt.input_device` (string, nombre exacto) en cualquier
   matriz, pero **la matriz versionada de este repo NO lleva valores
   personales de `input_device`** — sería fugar un identificador
   personal al historial público. La preferencia personal vive en una
   matriz EXTERNA fuera de Git (p. ej. `~/.config/glosomata/
   glosomata.json`, permisos 0600), seleccionada con `GLOSOMATA_CONFIG`
   (mecanismo vigente: ruta efectiva = env ?? `glosomata.json`).
2. **Set/get/validate del valor EFECTIVO, sin modificar la matriz
   versionada** — todo contra la ruta efectiva, jamás contra la del
   repo:
   - ver: `GLOSOMATA_CONFIG=<externa> glosomata config get engines`
     (lectura cruda de la ruta efectiva);
   - escribir: copiar la canónica a la externa 0600, editar la clave,
     y `GLOSOMATA_CONFIG=<externa> glosomata config set <candidato>` —
     el replace atómico + validación + backup de `config set` caen en
     la ruta EFECTIVA (backups junto al lock del runtime, no en el
     repo);
   - validar: `GLOSOMATA_CONFIG=<externa> glosomata config validate`
     (verifica TIPO y FORMA del nombre — charset/alias, la MISMA regla
     de §10.2; la PRESENCIA se revisa AL ABRIR, no aquí).
3. **Precedencia y no-fallback**: la preferencia es petición
   IMPLÍCITA — `--device` > `input_device` > `:0`. Se REVALIDA contra
   el listado fresco en CADA apertura: ausente o ambigua →
   `device_missing` (§3.1), JAMÁS caída a `:0` en silencio. Sin
   preferencia, conducta actual intacta. Cambio ENTRE operaciones:
   `config set` aplica en la operación SIGUIENTE (cada listen relee la
   matriz efectiva). Cambio DURANTE una captura: imposible en v1 — un
   proceso ffmpeg por captura; `stop` (trunca) + siguiente operación.
4. **doctor**: sección informativa `stt.input_device`
   `{name, resuelve, causa?, detalle?}` — reporta si hay preferencia y
   si resuelve; causas del conjunto cerrado `forma_invalida |
   plataforma_no_soportada | device_missing | device_list_unavailable`
   (con `resuelve:null` cuando el listado no pudo verificarse). El
   advisory JAMÁS afecta el exit del veredicto.
5. **MCP sin exposición**: la matriz saneada de `get_config` usa
   whitelist que NO incluye `input_device` — el nombre del dispositivo
   JAMÁS sale por MCP (test que lo afirma en la suite).

## 12. Mute

glosomata NO ofrece mute bajo ninguna semántica. Omitir `speak` /
`listen` es política del CONSUMIDOR (como el backoff ante
`channel_busy`); `stop` trunca la operación en curso DE SU runtime y no
apaga ningún micrófono; el mute del micrófono del sistema requiere
CoreAudio nativo (ADR futuro). Ninguna superficie de glosomata apaga el
micrófono de otro proceso en v1.

## 13. Frontera de integración con el consumidor de voz

1. **glosomata es proveedor de inventario y de semántica, no
   controlador**: el consumidor de voz puede usar `devices` (CLI/tool
   MCP, sólo lectura, sin tocar el canal) como fuente única de
   enumeración de hardware, y DEBE aplicar la semántica de este
   contrato POR REFERENCIA (ids efímeros por enumeración, re-validar
   contra listado fresco antes de cada captura, jamás fallback
   silencioso a `:0`, degradación honesta, `device_missing` como fallo
   de estado) para que las conductas no diverjan entre hermanos.
2. **Cada quien manda su captura**: la selección de entrada del
   consumidor vive en SU ffmpeg y DEBE replicar el binding por NOMBRE
   exacto único (§10: homónimos fail-closed, jamás índice desnudo,
   jamás fallback silencioso), validado contra `glosomata devices`; el
   mute/desmute del micrófono de ese consumidor es el gate de SU arnés
   (abrir/cerrar su captura). El «mute del consumidor» se le ordena a
   él, no a glosomata.
3. **Sin control cruzado**: el `stop` de glosomata no alcanza la
   captura de otro proceso (proceso ajeno y, además, stop es por
   runtime); el mute de glosomata no existe (§12).
4. **Disparador de revisión**: si DOS consumidores reales compartieran
   captura/canal, se abre la decisión de plano de control común
   (servidor o arnés compartido) con ADR — y SOLO ese es el aplazamiento
   por consumidores: la elección de entrada NO se difiere.

## 14. Historia

- v1 (2026-11-11): propuesta inicial (G0+G1) — inventario local de
  sólo lectura con dos fuentes (ffmpeg avfoundation + system_profiler),
  degradación honesta por fuente, código `devices_unavailable` con
  causas cerradas y variable `GLOSOMATA_SYSTEM_PROFILER`.
- ampliación G2 (2026-11-11): selección de entrada por nombre exacto
  (§3.1, §10) con alta de causa `device_list_unavailable` en el §5 del
  contrato de consumo; preferencia externa por defecto (§11) con regla
  de privacidad; §12 mute; §13 frontera de integración; enmienda de
  no-objetivos (§9): la entrada es seleccionable por nombre, la salida
  y el mute siguen sin oferta. Binding físico `inconclusive` hasta
  ensayo vivo autorizado.
