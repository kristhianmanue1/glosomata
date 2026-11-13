# ADR-012: diarización efímera con pyannote community-1

Estado: aceptado (decisión humana explícita del Operador, 2026-11-12).
Contrato asociado `docs/specs/contrato-diarizacion-v1.md` NORMATIVO
desde 2026-11-13 (aceptación del Operador tras el ensayo §9.4 y la
ronda adversarial `proceed`; historia v1.4, PR #48).
Numeración: 006/007 reservados (plan de consumo), 009 referenciado por
el plan de playground; este ADR toma 012.

## Contexto

El ecosistema crece: tequio (asistente de reuniones, proyecto aparte)
necesita «quién habla cuándo» sobre grabaciones que él mismo posee y
persiste; su especificación define embeddings, enrollment e
identificación de participantes como SU dominio. glosomata ya opera
percepción de voz local por subprocess (STT whisper.cpp, ADR-002): la
diarización es percepción de hablantes — hermana del STT, no del LLM
(ADR-003 intacto).

pyannote speaker-diarization-community-1: código MIT, pesos CC-BY-4.0,
repositorio gated en Hugging Face, modo offline oficial (espejo del
pipeline a disco con git-lfs y carga por ruta local), telemetría
opcional desactivable con `PYANNOTE_METRICS_ENABLED=0`. Inferencia
local con pyannote.audio ≥ 4 (Python ≥ 3.10).

Decisión del Operador (2026-11-12): la diarización entra a glosomata
como mecanismo EFÍMERO SIN RETENCIÓN — igual que `listen` devuelve una
transcripción sin conservar audio, `diarize` devuelve turnos de
hablante sin conservar nada. La persistencia de embeddings, enrollment
e identificación de participantes vive en el consumidor tequio.

## Decisión

1. **Superficie**: comando CLI `diarize --file <ruta-audio>` —
   superficie nueva ESTRICTA, CLI-only v1 (sin tool MCP). Recibe audio
   de entrada, devuelve por stdout turnos de hablante con marcas de
   tiempo en modo EXCLUSIVO (única salida v1), sin persistir nada. El
   archivo de entrada es propiedad del consumidor: se abre en sólo
   lectura; glosomata no lo modifica ni lo borra.
2. **Fuera del canal**: la diarización no captura ni reproduce audio;
   no toma `canal.lock` (mismo criterio que `devices`) y puede coexistir
   con `speak`/`listen`. `stop` y las señales del propio runtime SÍ la
   alcanzan (SIGKILL al grupo del subprocess; resultado truncado).
3. **Motor**: pyannote.audio ≥ 4 por subprocess Python con VENV
   SEPARADO del de kokoro/piper (torch, torchcodec y lightning no
   intoxican el venv compartido). Pesos espejados en disco por el
   Operador (aceptación de condiciones + token una sola vez, fuera del
   repo); glosomata JAMÁS descarga pesos ni abre red (mismo fail-closed
   que kokoro exige `model` local).
4. **Entorno del subprocess FIJADO** por glosomata, no heredado:
   `PYANNOTE_METRICS_ENABLED=0` (telemetría OFF por contrato) y
   `HF_HUB_OFFLINE=1` (cinturón contra cualquier fallback de red del
   loader de modelos).
5. **Topes EVALUABLES** en constraints: duración máxima del audio de
   entrada (`diar_max_duration_s`, default 14400 s) y presupuesto
   wall-clock por operación (`diar_max_wall_s`, default 7200 s; el
   corte real es SIGKILL al grupo).
6. **doctor**: sección `diar` sólo si la matriz declara el motor;
   declarada-but-rota tumba el exit (criterio phonon_ollama/lfm3); no
   declarada no afecta el veredicto (las matrices existentes siguen
   operativas).
7. **Taxonomía**: código nuevo `diar_failed` con causas cerradas (alta
   en el contrato de consumo §2.1 y en `contrato-diarizacion-v1.md` en
   el commit de la conducta, fase D2); `engines.diar` ausente →
   `not_supported` (código existente).
8. **Enmienda del no-objetivo** «WAV externo como entrada»: acotado a
   `listen`; la entrada de audio externo sólo es superficie de
   `diarize`.

## Alternativas descartadas

- **Diarización dentro de tequio**: duplicaría la frontera de motores
  de percepción de audio que glosomata ya opera; tequio conserva la
  identidad y la persistencia.
- **Tool MCP en v1**: recibir una RUTA de filesystem por MCP rompe la
  frontera curada (`get_config`, ronda 5: MCP jamás expone rutas del
  disco) y un agente remoto no comparte disco con el host de audio
  (contrato-hardware §8). Si aparece un consumidor MCP real:
  decisión nueva + ADR.
- **Reusar `stt_failed`**: cada superficie conserva su vocabulario
  (lección `devices_unavailable` vs `device_list_unavailable`); la
  diarización no es STT.
- **Hints de hablantes (`num/min/max_speakers`), embeddings o salida
  con solapes en v1**: tequio no los necesita para reconciliar
  transcripción; cada uno es una apertura medible (fingerprinting,
  rendimiento) que exige decisión propia.

## Consecuencias y límites

- Cambio material (superficie nueva a consumidor no controlado que
  procesa audio de contenido): ronda adversarial OBLIGATORIA antes de
  normativo (D3).
- La calidad (DER) y la velocidad del modelo son OBSERVACIONES, nunca
  cotas contratadas; las cifras upstream (31 s por hora de audio) son
  de H100 y no se transfieren a este host.
- La atribución CC-BY-4.0 del espejo de pesos es del Operador;
  glosomata no distribuye pesos (la instalación es del usuario, como
  Piper en ADR-005 y whisper.cpp).
- La caché interna del runtime de Python (p. ej. torch) queda fuera de
  la garantía de glosomata (como la política del daemon Ollama en
  ADR-010); el SCRIPT, en cambio, no escribe artefactos de datos.
- Ensayo vivo (fase D3) pendiente de autorización expresa del
  Operador; el guion propuesto vive en el contrato §9.

## Relación con otros ADR

- ADR-003 intacto: pyannote no es LLM ni orquestador; el núcleo no
  genera respuestas.
- ADR-002 ampliado en concepto: la percepción local por subprocess ya
  no es sólo STT. `engines.diar` NO es un motor `tts[]` y no declara
  `kill_switch`: el corte es por señal/grupo (stop, SIGINT/SIGTERM) y
  por el wall-clock evaluado, igual que el STT.
- Ecosistema: glosomata = percepción del canal (STT + turnos de
  hablante anónimos); tequio = grabaciones, embeddings e identidad;
  Lalia-Akuo = turnos conversacionales; LFM3 = inferencia.

## Nota de delegación (2026-11-13, decisión del Operador; no enmienda
la decisión de este ADR)

Origen: hallazgo I-3/m-2 y decisión O-6 del informe del revisor
Fable. La frase del Operador «listo ejedutado para estos comando
realizalos tu en adelante» (chat, 2026-11-12 ~21:58) delegaba sin
registro una acción que `AGENTS.md` §Prohibido reserva al Operador.
El Operador resolvió (chat, 2026-11-13 ~04:55 CDMX):

«ok se queda asi para descarga de modelos : Delegación acotada a esa
descarga (recomendada). El repo sigue diciendo claramente que
instalar y descargar es decisión tuya. Si mañana hace falta otro
modelo, te pido permiso.»

Registro:

1. La delegación queda **acotada** al espejado de los pesos de
   `pyannote/speaker-diarization-community-1` en `.local-models/`,
   ejecutado por el coordinador (2026-11-12 ~22:05). La decisión de
   este ADR NO cambia: glosomata (el software) jamás descarga pesos
   ni abre red; el espejo manual sigue siendo responsabilidad del
   Operador, delegable sólo por una delegación expresa y acotada
   como ésta.
2. Quedan registrados como hechos ejecutados bajo la autorización
   expresa del ensayo D3 (2026-11-12): la creación de `.venv-diar`
   (pyannote.audio 4.0.7, aislado del venv principal) y la
   instalación de `git-lfs` (brew) — constancia de versiones en los
   informes de coordinación.
3. `AGENTS.md` §Prohibido **sigue vigente sin cambios**: cualquier
   otra descarga de modelo o instalación requiere permiso del
   Operador, una por una.
4. El token de Hugging Face fue retirado del disco (2026-11-13,
   acción del coordinador): una descarga futura requiere un token
   nuevo entregado por el Operador.
