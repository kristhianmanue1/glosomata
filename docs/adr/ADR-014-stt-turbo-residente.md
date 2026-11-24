# ADR-014: motor STT Whisper large-v3-turbo residente para tequio

Estado: PROPUESTA (fase 2 de la orden del orquestador 2026-11-23;
autorización del motor por el Operador, cita en
`docs/peticion-orquestador-stt-turbo-20261123.md`). Pasa a aceptado
con la validación del diseño por el orquestador/tequio (interfaz) y
la revisión adversarial de este documento.
Numeración: 013 es del VAD (Silero); este ADR toma 014.

## Autoridad y su alcance (honesto, tras hallazgo H3 r1)

- **Literal del Operador** (decide el MOTOR, no la descarga):
  «nos vamos por turbo glosmata tendra tambien LFM3 pero para tequio
  usaremos turbo en su controtato asi que podemos solo cargar turbo».
- **Cuantización ELEGIDA por el Operador** (relay del orquestador,
  2026-11-23): **q8_0** es la versión para tequio; «q5_0 ya no hace
  falta (no se descarga; si ya estaba, se conserva sin usar y se
  anota)». El alcance del despliegue y del lock queda en SOLO q8_0.
- **Acotación de la descarga** (sha256 verificado contra el
  manifiesto oficial de whisper.cpp): es del ORQUESTADOR, por escrito,
  2026-11-23, y ahora referida sólo a q8_0. Estado único y
  consistente (vale también para Consecuencias y para el §8): la
  descarga de q8_0 está AUTORIZADA en CADENA — el Operador eligió
  motor y cuantización (literales arriba), el orquestador acotó
  origen oficial y sha256 — y su EJECUCIÓN se hace como la nota de
  delegación del ADR-012: quien despliega descarga, el servicio
  verifica fail-closed, y CUALQUIER otra descarga o instalación
  (otros modelos, whisper.cpp/CUDA/ffmpeg/Xcode, build-deps) exige
  consulta previa una por una.
- **Otras descargas/instalaciones** (código fuente de whisper.cpp
  por tag+sha, toolkit CUDA/cuBLAS en el Dell, ffmpeg si se usa,
  Xcode CLT en el Mac): CONSULTA PREVIA en cada caso, igual que los
  build-deps; nadie las instala por omisión.
- **Origen de los sha256 esperados**: el manifiesto del repo oficial
  de whisper.cpp (no un hash recalculado de lo descargado); el
  servicio arranca sólo si el espejo local de q8_0 coincide
  (fail-closed) y verifica también el sha256 del BINARIO construido
  contra el registrado en el lock de ese build (build declarado NO
  reproducible; el sha es del artefacto, por build). Si existiera un
  espejo q5_0 previo, se conserva SIN USAR y se anota en el lock
  (decisión del Operador).

## Contexto

tequio transcribe reuniones LARGAS por tramos CORTOS (~19 s de
media; 413 tramos en 2 h) mientras graba. El STT efímero por
petición recarga el modelo cada vez; con large-v3-turbo eso es
inaceptable. El Operador decidió: turbo para tequio, LFM3 sigue en
glosomata para TTS (ADR-011 intacto); la descarga queda acotada
como arriba (propuesta del orquestador, confirmación del Operador
pendiente; cualquier otra descarga o instalación se consulta antes).

Hoy tequio habla `POST /v1/chat/completions` con `input_audio`
(formato del gateway LFM3: Bearer + `X-Project-ID`).

## Decisión

1. **Artefacto de despliegue, no núcleo** (ver «Relación con
   ADR-008/§2.6» abajo). El servicio STT turbo es
   un componente que glosomata ENTREGA (`services/stt-turbo/`) y
   Malintzin DESPLIEGA en el Dell (systemd `--user`, tailnet,
   token). glosomata (CLI/MCP) SIGUE sin abrir servidor HTTP/socket:
   el núcleo nunca ejecuta ni instala nada de `services/`.
   El ADAPTADOR STT de la flota que le hablaría (cliente al
   servicio) es una apertura DISTINTA y DIFERIDA: exige su propio
   ADR/enmienda (matriz `engines.stt`, probe, `auth_file`, timeouts,
   causas fail-closed, cancelación, convivencia con `listen`/VAD
   ADR-013) y no forma parte de éste.
2. **Motor**: whisper.cpp (subprocess/librería según artefacto) con
   large-v3-turbo ggml; modelo RESIDENTE (cargado una vez por
   proceso del servicio). Cuantización ELEGIDA por el Operador:
   **q8_0** («q5_0 ya no hace falta»: no se descarga; un espejo
   q5_0 previo se conserva SIN USAR y se anota en el lock). La
   medición de VRAM del Dell valida la convivencia elegida.
   espejo local con sha256 verificado antes de arrancar
   (fail-closed: sha distinto → el servicio no arranca).
3. **Builds**: Dell Linux con CUDA (cuBLAS) para la RTX 2060;
   Mac con Metal (GGML_METAL). El «lock» de esta pieza NO es de
   ruedas Python: es un manifiesto versionado
   (`services/stt-turbo/lock.md` o json) con el release exacto de
   whisper.cpp (tag + sha del commit), flags de build por
   plataforma, y los sha256 de los dos modelos ggml. Las ruedas
   Python del entorno de diarización siguen en
   `requirements/diar-linux-cuda.lock` (R-1, sin cambios).
4. **Interfaz HTTP** (propuesta definitiva A, a confirmar por tequio
   en el acuerdo — especificación completa con campos en
   `docs/respuesta-tequio-stt-turbo.md` §1):
   - **Opción A (preferida por la petición)**: exponer
     `POST /v1/chat/completions` con `input_audio` y la misma
     autenticación (Bearer + `X-Project-ID`), de modo que tequio
     sólo cambie la URL. Arquitectura: whisper-server upstream SIN
     modificar (bound 127.0.0.1) + envoltorio fino propio como
     único expuesto a la tailnet. Coste: mantener el adaptador de
     forma versionado (subconjunto de chat completions, sin
     streaming en v1, errores con código sin contenido).
   - **Opción B**: `POST /v1/audio/transcriptions` (forma estándar
     STT). Coste para tequio: cambio de cliente y de parser.
   - Convivencia GPU: cerrojo común `flock` por segmento con
     prioridad STT; 503 + `Retry-After` del STT saturado; la
     política por defecto la fijan las mediciones del Dell. El
     envoltorio de diarización sale con **75 (EX_TEMPFAIL)** cuando
     el Dell está ocupado (el contrato de exit codes del CLI de
     glosomata queda intacto: 0/1/2) — detalle en
     `docs/respuesta-tequio-stt-turbo.md` §2-§3.
5. **Antialucinación** (tramos cortos, modelo grande): VAD Silero
   pre-filtro (ya en el ecosistema, ADR-013) o umbral `no_speech`;
   `audio_ctx`/equivalente para <30 s; **medición obligatoria** del
   ganado (síntesis adversarial: silencio, ruido, habla real
   sintética) antes de declarar la receta por defecto.
6. **Medición sintética en el Dell** (sin audio real, coordinada
   con Malintzin fuera de reuniones): VRAM residente; tiempo por
   tramo (mediana y p95 sobre ≥100 tramos sintéticos de ~19 s);
   VRAM con una diarización pyannote concurrente (convivencia con
   `requirements/diar-linux-cuda.lock`).
7. **Contrato `diarize`** (fase 2, cambio en este repo): enmienda
   v1.7 admitiendo hints opcionales `--min-speakers`/`--max-
   speakers` (pyannote los soporta; pasan como tokens argv al
   script; sin hints, conducta actual; validación enteros ≥1 con
   min ≤ max usando SOLO códigos existentes de la taxonomía —
   `usage`). Tope de pared: el DEFAULT 7200 NO se toca (es
   estabilidad v1.x y vive en contrato §9 + `src/diar.mjs` +
   schema): para 2–4 h de una pasada en el Dell se DOCUMENTA la
   configuración (`diar_max_wall_s` y `diar_max_duration_s` ≥
   14400, tope duro del schema 86400) en la guía de despliegue;
   los valores medidos del Dell informan la guía, no el default.
   Se ejecuta en rama propia con revisión.
8. **Descarga de modelos**: la ejecuta quien despliegue (Malintzin
   en el Dell; el Operador o su delegado en el Mac), bajo la
   autorización en cadena de «Autoridad y su alcance»; el
   servicio verifica sha256 contra el manifiesto oficial antes de
   cargar (fail-closed). glosomata no descarga.

## Requisitos de seguridad del servicio (hallazgo H1 r1)

El servicio recibe audio real por red; estos requisitos son parte
del contrato del artefacto y su revisión los exige:

- **Bind**: 127.0.0.1 y/o la interfaz tailnet del host; jamás
  0.0.0.0. Origen del token: lo genera Malintzin al desplegar
  (CSPRNG, archivo 0600 fuera de Git); rotación documentada;
  comparación en tiempo constante; fallos de credencial → 401/403
  sin detalle.
- **No persistencia** (AGENTS.md): ningún audio ni transcripción en
  disco; conversión y decodificación EN MEMORIA (temporales, si
  imperativos, en tmpfs borrado por petición). Logs del servicio:
  ids, códigos y duraciones, JAMÁS texto/transcripción (política
  vigente).
- **Topes**: cuerpo de entrada acotado (p. ej. ≤25 MiB base64 ≈
  ~19 MB de audio) y duración de tramo acotada (~120 s); tramos
  fuera de tope → error 4xx con código, sin procesar.
- **Concurrencia**: 1 síntesis a la vez (inference serializada);
  cola acotada con 503 al desbordar (misma semántica que el gateway
  LFM3, ADR-011). Timeout de request declarado.
- **Entrada**: WAV PCM 16 kHz mono (lo que tequio ya produce por
  tramo); cualquier otro códec exige ffmpeg en el lado del
  servicio, DECLARADO como dependencia de despliegue con consulta
  previa — la opción por defecto NO convierte códecs.
- **VRAM fail-closed**: criterio definido, no sólo medición — si al
  arrancar no hay VRAM libre suficiente (uma estimación declarada
  tras las mediciones del Dell), el servicio NO arranca (fail
  closed) salvo modo degradado EXPLÍCITO por configuración
  (CPU), nunca en silencio. La convivencia con la diarización se
  declara en la guía (serialización o coexistencia medida).
- **Antialucinación** (H5 r1): VAD Silero como pre-filtro del
  servicio es un USO DISTINTO del ADR-013 (fin de turno); se
  declara qué binario/modelo (v6.2.0) usa y que no se confunde con
  `stt.vad` del `listen`. La «medición obligatoria» tiene umbral:
  ≥100 tramos sintéticos adversariales (silencio/ruido/habla) y el
  ganado se reporta con la métrica de falsas palabras por hora
  igualada entre configuraciones; la receta por defecto se fija
  sólo si gana sin pérdida de recall.
- **Lock**: formato MÁQUINA-verificable (json) con: tag+sha del
  commit de whisper.cpp, flags de build por plataforma
  (`CMAKE_CUDA_ARCHITECTURES=75` para la 2060, `GGML_CUDA`),
  versión mínima del toolkit CUDA/driver, compilador, sha256 del
  binario resultante (build declarado NO reproducible: el sha
  identifica el artefacto), sha256 de los modelos ggml contra el
  manifiesto oficial, y verificación de submódulos.
- **Licencias** (H5 r1): whisper.cpp MIT, pesos Whisper MIT;
  confirmar que las conversiones ggml-turbo oficiales heredan y
  registrarlo en el lock (frontera de licencias como ADR-005/010).

## Relación con ADR-008 y el pacto §2.6 (hallazgo H2 r1)

La comparación con el gateway LFM3 NO es exacta y este ADR no la
usa: el gateway vive en OTRO repo (LFM3-Omni-FK); el código de este
servicio se versionaría en `services/stt-turbo/` DENTRO de
glosomata, y ADR-008 rechazó «servidor dentro de glosomata» para el
playground. La reconciliación honesta:

- **El no-objetivo se acota con precisión**: «sin servidor
  HTTP/socket» rige al NÚCLEO (CLI/MCP/contratos): glosomata nunca
  ABRE un puerto ni ejecuta código de `services/`. Los artefactos
  bajo `services/` son código de despliegue para TERCEROS
  (Malintzin), muerto para el núcleo, sin instalación, sin tests del
  núcleo que lo ejecuten, y cada uno exige ADR propio con esta
  sección. El contrato de consumo §2.6 se ENMIENDA en el commit de
  código del servicio para decir exactamente eso.
- **Alternativa de hogar**: si el Operador prefiere el precedente
  playground (repo aparte que consume glosomata), el diseño se muda
  sin cambios y `services/` nunca nace. Decisión del Operador al
  aceptar este ADR; por defecto (lo que la petición pide: «tú
  entregas el artefacto») queda en `services/` con la cláusula de
  alcance anterior.
- El futuro adaptador STT de la flota (cliente tailnet, no loopback)
  es una TERCERA apertura: §2.6 exige decisión y ADR propios —
  diferido explícitamente (§1).

## Alternativas descartadas

- **STT efímero por petición**: recarga del modelo por tramo; con
  413 tramos por reunión es el problema, no la solución.
- **LFM3 para STT de tequio**: el Operador lo pospuso («nos vamos
  por turbo… para tequio usaremos turbo»); LFM3 conserva TTS.
- **whisper-server upstream desnudo**: no habla la forma
  `chat/completions`+`input_audio` que tequio ya usa; exige cambio
  de cliente (es la opción B con otro nombre).
- **El núcleo de glosomata abre el puerto**: rechazado por ADR-008
  para el núcleo; el artefacto `services/` lo evita con la cláusula
  de alcance de «Relación con ADR-008/§2.6» (y queda a decisión del
  Operador mudarlo a repo aparte, precedente playground).

## Consecuencias

- Nueva familia de artefactos `services/` en el repo: código de
  despliegue para terceros (Malintzin), muerto para el núcleo; el
  gate de tamaños y la suite los tratan como código normal y el
  contrato de consumo §2.6 se enmienda en el commit del servicio.
- La descarga de q8_0 queda AUTORIZADA EN CADENA (Operador: motor y
  cuantización; orquestador: origen oficial y sha256) y su ejecución
  sigue el patrón de la nota de delegación del ADR-012 (quien
  despliega descarga; verificación fail-closed en arranque);
  build-deps (whisper.cpp, CUDA, ffmpeg, Xcode) y cualquier otro
  modelo o instalación = consulta previa una por una.
- Interfaz propuesta definitiva A (especificación con campos en
  `docs/respuesta-tequio-stt-turbo.md`, que además responde las seis
  preguntas de tequio: servidor/ruta, convivencia GPU con cerrojo
  común y prioridad STT, exit 75 del envoltorio de diarización, tope
  7200 intacto con guía de configuración, antialucinación con VAD y
  sin condicionar texto previo, topes de cuerpo y errores sin
  contenido): el ADR no se acepta hasta que tequio confirme.
- Mediciones del Dell: observaciones, nunca cotas (regla vigente);
  el criterio de VRAM (arranque fail-closed / degradado explícito)
  sí es contractual.
