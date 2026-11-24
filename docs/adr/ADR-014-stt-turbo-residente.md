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
- **Acotación de la descarga** (q5_0/q8_0 del repo oficial de
  whisper.cpp, sha256 verificado): es del ORQUESTADOR, por escrito,
  2026-11-23. La regla del repo es permiso humano explícito una por
  una: la descarga concreta queda PENDIENTE de esa confirmación del
  Operador; este ADR la registra como propuesta acotada, no como
  autorización consumada.
- **Otras descargas/instalaciones** (código fuente de whisper.cpp
  por tag+sha, toolkit CUDA/cuBLAS en el Dell, ffmpeg si se usa,
  Xcode CLT en el Mac): CONSULTA PREVIA en cada caso, igual que los
  build-deps; nadie las instala por omisión.
- **Origen de los sha256 esperados**: el manifiesto del repo oficial
  de whisper.cpp (no un hash recalculado de lo descargado); el
  servicio arranca sólo si el espejo local coincide (fail-closed) y
  verifica también el sha256 del BINARIO construido contra el
  registrado en el lock de ese build (build declarado NO
  reproducible; el sha es del artefacto, por build).

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
   proceso del servicio). Cuantizaciones autorizadas: q5_0 (por
   defecto en el Dell de 6 GB) y q8_0 (alternativa de calidad);
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
4. **Interfaz HTTP** (a acordar con tequio-capitan-opus vía
   orquestador — PENDIENTE, este ADR propone):
   - **Opción A (preferida por la petición)**: exponer
     `POST /v1/chat/completions` con `input_audio` y la misma
     autenticación (Bearer + `X-Project-ID`), de modo que tequio
     sólo cambie la URL. Coste: glosomata mantiene un adaptador de
     forma (semántica de chat reutilizada para transcripción: fea
     pero estable para el consumidor; el wrapper es fino y
     versionado).
   - **Opción B**: `POST /v1/audio/transcriptions` (forma estándar
     STT, multipart o base64). Coste para tequio: cambio de cliente
     y de parser de respuesta; ganancia: semántica limpia.
   - Recomendación del capitán: **A**, con `model` del cuerpo
     nombrando la cuantización (`large-v3-turbo-q5_0`) y la
     respuesta en la MISMA forma que tequio ya parsea del gateway.
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
   acotación del orquestador CONFIRMADA por el Operador; el
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
- La acotación de descarga queda REGISTRADA como propuesta del
  orquestador PENDIENTE de confirmación del Operador (regla una por
  una); build-deps (whisper.cpp, CUDA, ffmpeg, Xcode) = consulta
  previa. Cualquier otro modelo o instalación, igual.
- Interfaz PENDIENTE de acuerdo: este ADR no se acepta hasta que el
  orquestador confirme A o B con tequio; el resto del diseño no
  depende de esa elección. La premisa «tequio ya parsea
  chat/completions+input_audio» es testimonio del orquestador
  (verificable sólo del lado de tequio; H6 r1).
- Mediciones del Dell: observaciones, nunca cotas (regla vigente);
  el criterio de VRAM (arranque fail-closed / degradado explícito)
  sí es contractual.
