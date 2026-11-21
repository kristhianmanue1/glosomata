# Contrato de diarización — v1 (turnos de hablante efímeros)

> **Estado:** NORMATIVO desde 2026-11-13 — aceptación explícita del
> Operador («adelante con trodas las recomendaciones», 2026-11-13
> ~04:40 CDMX; recomendación O-7 del informe del revisor Fable) tras
> el ensayo vivo §9.4 (historia v1.3) y la ronda adversarial con
> veredicto `proceed` anclado a `afc37f5` (PR #47, integrado en
> `main`). El hallazgo MED de frontera (WAV truncado con cabecera
> válida → `inferencia_fallida`) queda ABIERTO, declarado sin
> minimizar, con seguimiento en el issue #43. Modelo y
> vocabulario: `docs/specs/contrato-consumo-agentes-v1.md`; la taxonomía
> de errores sigue mandando en `docs/specs/specs-y-contratos-v1.md`.
> Decisión: ADR-012 (aceptada 2026-11-12; este contrato es su forma
> observable).

## 1. Alcance

Diarización de hablantes sobre un ARCHIVO de audio provisto por el
consumidor, en inferencia 100% local (pyannote
speaker-diarization-community-1 sobre su espejo en disco; ADR-012).
Mecanismo EFÍMERO SIN RETENCIÓN: igual que `listen` devuelve una
transcripción sin conservar audio, `diarize` devuelve turnos de
hablante sin conservar nada — ni audio, ni resultados, ni artefactos
intermedios. El archivo de entrada es propiedad del CONSUMIDOR:
glosomata lo abre en modo sólo lectura y jamás lo modifica ni lo
elimina.

La identidad de hablantes (enrollment, embeddings, «quién es») NO es
de esta superficie: vive en el consumidor. `diarize` sólo separa
QUIÉN-CUÁNDO con pseudónimos locales a la respuesta.

## 2. Superficie CLI (única en v1)

`glosomata diarize --file <ruta-audio> [--embeddings]` — superficie
NUEVA ESTRICTA: `--file` con valor y, opcionalmente, el flag sin
valor `--embeddings` (a lo sumo una vez, antes o después de
`--file`); cualquier otra forma → exit 2 `usage` (no hereda la
tolerancia legacy). SIN tool MCP en v1 (§10); sin flags de hints de
hablantes; sin selección de modo.

Forma de respuesta (exit 0, JSON por stdout) — SIN `--embeddings`
(idéntica byte a byte a la de siempre, enmienda 2026-11-17):

```json
{
  "turns": [
    { "speaker": "SPEAKER_00", "start_s": 0.2, "end_s": 1.5 }
  ],
  "num_speakers": 1,
  "mode": "exclusive",
  "device": "cpu",
  "duration_ms": 45320
}
```

Semántica de cada campo:

- `turns[]`: ordenados por `start_s` (monotónico) y SIN solapes
  (`end_s <= start_s` del siguiente). La salida es la diarización
  EXCLUSIVA de community-1 — un solo hablante activo por instante, el
  más probable de ser transcrito —, diseñada para reconciliar con los
  timestamps de un STT. La salida con solapes (regular) no se ofrece
  en v1 (§10).
- `turns[].speaker`: cadena OPACA, canonicada por glosomata por orden
  de primera aparición (`SPEAKER_00`, `SPEAKER_01`, …); las etiquetas
  crudas del motor jamás salen. Estable y consistente DENTRO de una
  respuesta; SIN identidad entre invocaciones (§9.2).
- `turns[].start_s`/`end_s`: segundos desde el inicio del archivo,
  precisión de milésimas, `end_s > start_s`.
- `num_speakers`: conteo derivado de la respuesta (informativo).
- `mode`: constante `"exclusive"` en v1.
- `duration_ms`: entero no negativo, wall-clock de la operación (misma
  métrica transversal del contrato de consumo §5).
- `device` (v1.6, petición 2026-11-21): el dispositivo de cómputo
  EFECTIVO de la inferencia (`cpu|cuda|mps`). Default `cpu`; si la
  matriz pide uno no disponible, el motor vuelve a CPU SIN caerse y
  este campo lo evidencia (pedir `cuda` en un host sin CUDA entrega
  `"device": "cpu"`): ése ES el aviso de la vuelta atrás — el stderr
  del subprocess se drena por política de logs. La forma de la
  salida no cambia por el dispositivo: mismos turnos, misma
  equivalencia numérica (verificada cpu↔mps: turnos idénticos,
  coseno de huellas 1.000000; `docs/diarize-dispositivo-gpu.md`).

CON `--embeddings` (enmienda 2026-11-17, ADR-012) la respuesta añade
exactamente dos campos:

```json
{
  "turns": [ "..." ],
  "num_speakers": 2,
  "mode": "exclusive",
  "speakers": {
    "SPEAKER_00": { "embedding": [0.014, 0.4, 0.55, 0.0, 0.0],
                    "dim": 256 },
    "SPEAKER_01": { "embedding": [-0.45, 0.19, -0.05, 0.0, 0.0],
                    "dim": 256 }
  },
  "embedding_model": "speaker-diarization-community-1#embedding",
  "duration_ms": 45320
}
```

- `speakers`: UNA huella por etiqueta CANÓNICA (no por turno): el
  CENTROIDE por hablante que el propio pipeline calcula al
  clusterizar (`DiarizeOutput.speaker_embeddings`; ninguna pasada
  extra de inferencia — el coste de la opción es la serialización).
  `embedding` es un arreglo de números finitos; `dim` su longitud
  (256 en community-1, WeSpeaker). Audio en silencio: `speakers: {}`.
- `embedding_model`: constante contractual que identifica el origen
  de las huellas: el subfolder `embedding` del pipeline espejado.
- Emparejamiento entre llamadas/tramos: métrica recomendada
  COSENO sobre los vectores L2-normalizados que entrega el motor.
  La identidad resultante es del CONSUMIDOR (§11): la huella es
  materia prima, no un identificador.
- Fail-closed: cobertura exacta entre huellas y etiquetas con turno,
  números finitos y `dim` homogénea — cualquier incoherencia del
  motor → `diar_failed/inferencia_fallida`, sin resultado parcial.

Truncado por `stop`/señal: exit 1, resultado JSON por **stdout** —
`{"turns": null, "truncated": true, "duration_ms": N}` — y **stderr
vacío**, sin código de error (espejo exacto de la semántica del
`speak` truncado; `stopped` sigue siendo exclusivo de `listen`).

## 3. Fallos explícitos

Exit 1 con `{error, causa?}` por stderr (CLI). Tres clases, vocabularios
distintos:

| Fallo | Respuesta |
|---|---|
| Capacidad no configurada (`engines.diar` ausente en la matriz efectiva) | `not_supported` (código existente; fail-closed, sin default oculto) |
| Fallo de operación | `diar_failed` con `causa` del conjunto cerrado §3.1 |
| Matriz ilegible | `config_unreadable` (existente) |

### 3.1 Causas cerradas de `diar_failed`

| `causa` | Significado exacto |
|---|---|
| `audio_ilegible` | La ruta no existe, no se puede leer, no es audio decodificable o está vacía. SIN especular la causa (lección ffmpeg: un exit genérico no prueba permiso). |
| `audio_demasiado_largo` | La duración del audio excede `diar_max_duration_s` (tope EVALUADO: el motor reporta la duración antes de inferir). |
| `timeout_inferencia` | La inferencia excedió `diar_max_wall_s` (tope EVALUADO: SIGKILL al grupo del subprocess). |
| `inferencia_fallida` | El subprocess terminó sin un resultado JSON válido (crash, exit ≠ 0, stdout ilegible). Fail-closed: sin resultado parcial. |
| `python_ausente` / `script_ausente` / `pesos_ausentes` | El python del venv, el script o el espejo del pipeline declarados en la matriz no existen o no son ejecutables/íntegros en el momento de la operación (re-chequeo en cada apertura, como `listen` re-chequea ffmpeg). |
| `probe_fallido` | El probe estructural del motor falló de forma no clasificable. |

Sin base para clasificar, `causa` se omite. El alta de `diar_failed`
en la taxonomía (contrato de consumo §2.1) se ejecutó con la conducta
(fase D2, 2026-11-12). La taxonomía y este conjunto sólo crecen.

## 4. Motor y entorno del subprocess (EngineDiar)

- Invocación: `<python> <script> <pipeline_dir> <audio_ruta>
  <max_duration_s> <embeddings:0|1> <device:cpu|cuda|mps>` — argv sin
  contenido alguno: sólo rutas (la del audio es exposición
  declarada, §8), el tope de duración en segundos (H-1 del issue
  #43: el límite configurable llega al motor como 5º token; el
  script reporta la duración ANTES de inferir y responde exit 4 si
  excede), el modo de huellas como 6º (enmienda 2026-11-17) y el
  dispositivo de cómputo como 7º (v1.6, petición 2026-11-21: el
  EFECTIVO —tras la vuelta a CPU— viaja en la respuesta `device`).
  Valor de dispositivo inválido → exit 2 del script (mal uso).
  stdin cerrado (EOF limpio). stdout del
  subprocess: UN objeto JSON con la forma `{"device": usado,
  "turns":[…]}` (etiquetas crudas; glosomata canóniza §2) y, con
  `embeddings=1`, además `{"embeddings": {"<etiqueta cruda>":
  [floats]}}` (el centroide por hablante crudo; glosomata re-llavea
  por etiqueta canónica y valida), acotado a 16 MiB (más allá →
  `inferencia_fallida`); cualquier otra cosa es
  `inferencia_fallida`. stderr del subprocess: drenado y descartado
  (política de logs).
- Exit codes del script (contrato Node↔script, D2): `0` ok; `3`
  `audio_ilegible` (no existe, ilegible, vacío o sin duración
  decodificable en la sonda); `4` `audio_demasiado_largo`; `2` mal
  uso del propio script — incluido un entorno sin las dos variables
  exigidas: el script REHÚSA correr sin telemetría OFF (fail-closed,
  defensa en profundidad de la decisión del Operador); cualquier otro
  → `inferencia_fallida`.
- Entorno FIJADO por glosomata, no heredado:
  `PYANNOTE_METRICS_ENABLED=0` — telemetría OFF por contrato, sin
  importar el ambiente del proceso padre — y `HF_HUB_OFFLINE=1` —
  cinturón contra cualquier fallback de red del loader. El motor es el
  espejo LOCAL del pipeline (ADR-012): la carga es por ruta, jamás por
  repo de Hugging Face.
- Venv SEPARADO del venv de kokoro/piper (ADR-012):
  `engines.diar.python` apunta al intérpreto propio; pyannote.audio
  ≥ 4 y sus dependencias viven ahí, instalados por el Operador
  (glosomata jamás instala ni actualiza dependencias).
- El SCRIPT no escribe artefactos de datos: ni RTTM, ni WAV
  intermedio, ni resultados. La caché interna del runtime de Python
  (p. ej. torch) es comportamiento del motor, fuera de la garantía de
  glosomata (ADR-012).
- Tolerancia de formato delegada al motor: community-1 ingiere mono
  16 kHz y remuestrea/downmixa automáticamente; todo rechazo de
  formato se reporta como `audio_ilegible` (sin vocabulario de codecs
  en esta superficie).

## 5. Contención y señales

- `diarize` corre FUERA del canal: no toma `canal.lock` (no captura ni
  reproduce audio; mismo criterio que `devices`) y puede ejecutarse en
  paralelo con `speak`/`listen`. No produce `channel_busy` ni la sufre.
- `stop` (y SIGINT/SIGTERM) del PROPIO runtime la alcanzan: el
  subprocess corre en grupo registrado; el corte es SIGKILL al grupo y
  la operación resuelve truncada (§2). Sin alcance cross-runtime
  (contrato de consumo §5.1). H-2 del issue #43, resuelto en D2:
  aunque `diarize` no toma `canal.lock`, se REGISTRA como esperador
  (socket propio bajo `espera/` del runtime, el mismo mecanismo de
  `speak --text-stdin`): `glosomata stop` de otro proceso le entrega
  la orden con acuse. Sin registro, la operación falla (fail-closed).
- La inferencia es CPU-intensiva por naturaleza; glosomata no la
  serializa ni la acota por debajo del wall-clock de §3.1. Cuándo
  despacharla es política del consumidor; la contención de CPU del
  host no es de este contrato.

## 6. Matriz de configuración (schema, validate y doctor cableados en D1)

```json
"engines": {
  "tts": [ "..." ],
  "stt": { "..." },
  "diar": {
    "python": ".venv-diar/bin/python",
    "script": "src/diar/diarize_pyannote.py",
    "pipeline": ".local-models/pyannote/speaker-diarization-community-1",
    "device": "cpu"
  }
}
```

- `engines.diar` es OPCIONAL (abierto al schema formal en D1). Ausente
  → `not_supported` (§3). `config validate`/`config set`: `diar`
  DECLARADO debe pasar el probe (misma regla que `phonon_ollama`/
  `lfm3`: declarado-but-roto bloquea el set). Clave opcional
  `device` (`cpu|cuda|mps`, default `cpu`, v1.6/petición 2026-11-21):
  dispositivo de cómputo; no disponible → vuelta a CPU sin caer, con
  el efectivo en la respuesta (`docs/diarize-dispositivo-gpu.md`).
- NO es un motor `tts[]`: no declara `kill_switch` (el corte es por
  señal/grupo y por el wall-clock evaluado, como el STT) y no hay
  selección múltiple: cero o un motor de diarización.
- Rutas: siguen las convenciones vigentes (`.venv-diar`,
  `.local-models/`); las rutas personales del Operador que no sigan
  la convención viven en matriz externa (`GLOSOMATA_CONFIG`, 0600,
  fuera de Git — mismo criterio de privacidad que `input_device`).
  Las relativas se resuelven contra el CWD del proceso (regla
  transversal de la guía).
- constraints nuevos (opcionales, con default): `diar_max_duration_s`
  (default 14400; tope duro del schema 86400) y `diar_max_wall_s`
  (default 7200; mínimo 60). Ambos EVALUADOS (§3.1) — lectores
  cableados en D2 —, a diferencia del `max_latency_ms` de TTS, que es
  declarativo.

## 7. doctor (cableado en D1)

- `engines.diar` ausente: la sección `diar` NO aparece y el veredicto
  NO cambia (las matrices existentes siguen dando el mismo exit).
- `engines.diar` declarado: sección `diar: {ok, causa?}` con las
  causas del conjunto cerrado de §3.1 (parte estructural:
  `python_ausente`, `script_ausente`, `pesos_ausentes`,
  `probe_fallido`). DECLARADO-BUT-ROTO TUMBA EL EXIT (criterio
  `phonon_ollama`/`lfm3`; decisión del Operador 2026-11-12). El probe
  es ESTRUCTURAL (existencia y forma de python/script/pipeline con
  `config.yaml`): no ejecuta nada.

## 8. No-retención, privacidad y logs

- Sin persistencia: ningún artefacto de la operación sobrevive al
  proceso (§4). El archivo del consumidor queda exactamente como
  estaba.
- Logs: sólo ids, códigos, causas y duraciones — NUNCA turnos,
  etiquetas, marcas de tiempo ni la ruta del audio (la ruta puede
  contener nombres de personas o reuniones). Las respuestas de error
  tampoco incluyen la ruta.
- Exposición en argv DECLARADA: la ruta del audio viaja en el argv
  del CLI y del subprocess (visible en `ps` mientras vivan los
  procesos). Si la ruta embarca nombres personales, es exposición
  real declarada (precedentes: nombre de dispositivo en
  `contrato-hardware-v1.md` §10, `validate --session`); no hay
  alternativa en v1.
- Telemetría del motor: desactivada por entorno fijado (§4). El
  README de pyannote-audio documenta que su telemetría envía origen
  del pipeline, clase, duración de archivos y hints de hablantes; con
  `PYANNOTE_METRICS_ENABLED=0` fijado por glosomata, nada de eso
  sale. La garantía es del entorno del subprocess, no del motor.
- **Huellas de voz = DATO BIOMÉTRICO** (enmienda 2026-11-17): sólo
  viajan en la respuesta por STDOUT al consumidor que las pidió con
  `--embeddings`; JAMÁS en disco, temporales, logs, stderr,
  respuestas de error ni MCP-log (la política de ids/códigos/
  duraciones queda intacta). glosomata no las retiene ni las deriva
  dos veces. La custodia de las huellas recibidas —incluido su marco
  legal de biometría— es responsabilidad del CONSUMIDOR (§11).

## 9. Límites declarados y residuales

1. **Calidad y velocidad: OBSERVACIONES, no cotas** (regla de
   mediciones del contrato de consumo §10). Las cifras upstream (DER
   11.7–46.8% por benchmark; 31 s por hora de audio en H100) no se
   contratan ni se transfieren a este host.
2. **Etiquetas SIN identidad**: los pseudónimos canonicados de una
   respuesta NO son los de otra (la asignación y permutación de
   clusters es del motor, con o sin el mismo archivo). El consumidor
   que necesite estabilidad entre corridas la impone él con las
   huellas de `--embeddings` (emparejamiento por coseno, §2);
   glosomata no contrata determinismo de etiquetas.
3. **El modo exclusivo ELIGE un hablante por instante**: en solapes
   reales, el hablante secundario del solape no aparece en el turno
   (ese es el diseño del modo: favorecer la reconciliación con STT).
   Declarado, no corregido.
4. **Conducta física sin ensayo vivo**: la verificación local del
   motor (pesos cargando, turnos plausibles, truncado por stop) es la
   fase D3, PENDIENTE de autorización expresa del Operador. Guion
   propuesto: espejo del pipeline → audio sintético de dos fuentes
   alternadas → turnos plausibles (2 pseudónimos, sin solapes) →
   audio corrupto → `audio_ilegible` → `stop` en vuelo → truncado →
   duración sobre el tope → `audio_demasiado_largo`. Hasta entonces:
   conducta física del motor = `inconclusive`.
5. **Dependencias del venv propio**: instalación y actualización son
   del Operador. Una actualización de pyannote.audio que cambie
   etiquetas o precisión no rompe este contrato: la superficie declara
   las etiquetas opacas y fija la forma §2. Para las HUELLAS (v1.5):
   `dim` y `embedding_model` son del pipeline espejado — si una
   actualización cambia la dimensión o el modelo de embedding, el
   consumidor lo VE (`dim`/`embedding_model` viajan en la respuesta)
   y el emparejamiento entre huellas de orígenes distintos es inválido
   por diseño: comparar sólo huellas del mismo `embedding_model`.
6. **Huellas y hablantes sin turno exclusivo** (v1.5, H3/H4 de la
   ronda r1): el script filtra las huellas a las etiquetas con al
   menos un turno EXCLUSIVO — un hablante cuyo habla quedó íntegra en
   solapes (modo exclusivo, §9.3) NO aparece en los turnos y por
   tanto NO lleva huella en la respuesta; su voz está en los
   solapes que el modo descarta. Un vector de NORMA CERO (artefacto
   de padding del motor para hablantes «extra») se rechaza
   fail-closed (`inferencia_fallida`): una huella no emparejable
   (coseno indefinido) no se entrega como si lo fuera.

## 10. Lo que v1 NO ofrece (pacto de no sorpresa)

Sin tool MCP (una ruta de filesystem por MCP rompe la frontera curada;
consumidor MCP real → decisión + ADR), sin scores o confianza en la
salida, sin hints `num/min/max_speakers`, sin modo con
solapes (regular), sin audio por stdin, sin streaming, sin cola, sin
servidor, sin retención. Las huellas de voz SON opcionales desde la
enmienda v1.5 (`--embeddings`, ADR-012 2026-11-17): aditivas, sólo
stdout, sólo con pedido expreso. Los no-objetivos del contrato de
consumo §2 siguen vigentes. Cualquier otra apertura exige decisión
humana y ADR propios.

## 11. Frontera con el consumidor (tequio)

1. El consumidor posee la grabación, la transcripción y la identidad:
   `diarize` le entrega turnos anónimos reconciliables con los
   timestamps de SU transcripción (modo exclusivo) y, si los pide,
   una huella por hablante (v1.5) para mantener la identidad ENTRE
   tramos de una misma llamada — emparejamiento por coseno entre
   huellas del mismo `embedding_model` (§9.5).
2. El consumidor NO debe interpretar etiquetas como identidades
   estables (§9.2) ni afirmar participación a partir de un solo
   turno: la atribución de identidad es SU dominio y SU
   responsabilidad. La huella es materia prima para SU emparejamiento
   —un dato biométrico cuya custodia y marco legal le pertenecen—,
   no un identificador emitido por glosomata.
3. Reproceso: el consumidor puede volver a llamar `diarize` sobre el
   mismo archivo; glosomata no recuerda nada entre llamadas y las
   etiquetas pueden permutar entre corridas (§9.2): los turnos son
   equivalentes, las etiquetas no — las huellas sí son comparables
   entre corridas del mismo `embedding_model`.
4. El audio de entrada puede contener voces de terceros no informados:
   la decisión de grabar y procesar es del consumidor y de su marco
   legal; glosomata sólo declara que el procesamiento es local y sin
   retención.

## 12. Historia

- v1 (2026-11-12): propuesta inicial (fase D0, ADR-012) — decisión del
  Operador: mecanismo efímero sin retención, CLI-only, modo exclusivo,
  venv separado, topes evaluables (14400 s de audio / 7200 s de
  wall-clock), doctor con gate en declarado-but-roto, telemetría OFF
  por entorno fijado. Ensayo vivo (D3) pendiente de autorización
  expresa.
- v1.1 (2026-11-12): D1 ejecutado — schema abierto a `engines.diar`
  (tres rutas requeridas si se declara) y a los constraints
  evaluables; `config validate`/`set` sondean el diar declarado;
  `doctor` gana la sección con gate (§7). La superficie `diarize`,
  el script Python y el alta de `diar_failed` siguen en D2; H-1/H-2
  del issue #43 son trabajo de D2, H-3 del guion D3.
- v1.2 (2026-11-12): D2 ejecutado — comando `diarize --file`
  (superficie estricta §2) con turnos canónicos, modo exclusive,
  truncado espejo de speak; alta de `diar_failed` (contrato de
  consumo §2.1) con causas cerradas §3.1; script
  `src/diar/diarize_pyannote.py` con exit codes 0/3/4/2 (§4); H-1
  resuelto (tope de duración como 5º token de argv) y H-2 resuelto
  (registro en `espera/` para el stop cross-process); tope de stdout
  16 MiB. Verificación física del motor sigue `inconclusive` hasta el
  ensayo vivo D3 (pendiente de autorización expresa).
- v1.3 (2026-11-12): **ensayo vivo D3 ejecutado** (autorización
  expresa; espejo descargado por el Operador; informe:
  `~/www/aria/informe-diarize-d3-tramo2-2026-11-12.md`, registro en
  el issue #43) — guion §9.4 completo sobre audio sintético de dos
  voces locales alternadas: turnos plausibles (2 pseudónimos,
  alternancia exacta, sin solapes, 12.8 s), `audio_ilegible`
  (corrupto sin header), truncado por `stop` cross-process en vuelo,
  `audio_demasiado_largo` (rechazo temprano), H-3 confirmado
  (silencio → `turns: []`, `num_speakers: 0`) y nota de spawn-error
  evidenciada. `doctor`/`config validate` en verde contra el espejo
  real. **Hallazgo de frontera (abierto)**: un WAV truncado con
  header RIFF válido pasa la sonda de duración y clasifica
  `inferencia_fallida` (no `audio_ilegible`); propuesta de enmienda
  de §3.1/§9.4 en el informe, pendiente de decisión. El estado
  PROPUESTA no cambia: normativo exige decisión del Operador.
- v1.4 (2026-11-13): **NORMATIVO** — aceptación explícita del
  Operador («adelante con trodas las recomendaciones», 2026-11-13
  ~04:40 CDMX; recomendación O-7 del informe del revisor Fable) tras
  el ensayo §9.4 (v1.3) y la ronda adversarial `proceed` anclada a
  `afc37f5` (PR #47, integrado en `main`). El estado pasa de
  PROPUESTA a normativo sin cambios de conducta: D0–D3 cerrados. El
  hallazgo MED de frontera (WAV truncado con cabecera válida →
  `inferencia_fallida`) SIGUE ABIERTO con seguimiento en el issue
  #43. Conforme al canon de §6 (rutas convencionales en la matriz
  versionada; precedente whisper/piper), `engines.diar` queda
  declarado en `glosomata.json` del repo — mismo commit.
- v1.5 (2026-11-17): **enmienda de huellas de voz opcionales**
  (ADR-012, enmienda 2026-11-17; autorización literal del Operador
  vía orquestador devherdr-expert): `diarize --embeddings` añade
  `speakers` (un centroide por etiqueta canónica, WeSpeaker 256-d en
  community-1 — sin modelos ni cómputo nuevos: son los centroides
  del clustering) y `embedding_model`; emparejamiento recomendado por
  coseno. ADITIVO y OPCIONAL: sin el flag la salida es idéntica byte
  a byte. Huella = dato biométrico: sólo stdout, jamás disco/logs/
  stderr (§8); custodia del consumidor (§11). Sin flag MCP nuevo
  (diarize sigue CLI-only). El contrato SIGUE NORMATIVO.
- v1.6 (2026-11-21): **dispositivo de cómputo opcional** (petición
  del Operador vía tequio/Malintzin, autorizada con «adelante con
  recomendaciones»): `engines.diar.device` (`cpu|cuda|mps`, default
  `cpu`) viaja al script como 7º token; si el pedido no está
  disponible el motor VUELVE a CPU sin caerse y la respuesta gana
  `device` con el EFECTIVO (aditivo: consumidor compatible según
  contrato de consumo §2 — el aviso de la vuelta atrás es ese
  campo). Verificado en motor real (cpu↔mps: turnos idénticos,
  coseno de huellas 1.000000; camino de fallback cuda→cpu). Guía de
  despliegue CUDA para el Dell en `docs/diarize-dispositivo-gpu.md`.
  El contrato SIGUE NORMATIVO.
