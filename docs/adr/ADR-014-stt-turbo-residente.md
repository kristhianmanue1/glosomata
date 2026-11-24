# ADR-014: motor STT Whisper large-v3-turbo residente para tequio

Estado: PROPUESTA (fase 2 de la orden del orquestador 2026-11-23;
autorización literal del Operador en
`docs/peticion-orquestador-stt-turbo-20261123.md`). Pasa a aceptado
con la validación del diseño por el orquestador/tequio (interfaz) y
la revisión adversarial de este documento.
Numeración: 013 es del VAD (Silero); este ADR toma 014.

## Contexto

tequio transcribe reuniones LARGAS por tramos CORTOS (~19 s de
media; 413 tramos en 2 h) mientras graba. El STT efímero por
petición recarga el modelo cada vez; con large-v3-turbo eso es
inaceptable. El Operador decidió: turbo para tequio, LFM3 sigue en
glosomata para TTS (ADR-011 intacto). Autorización de descarga
EXPRESA y acotada: sólo Whisper large-v3-turbo ggml (q5_0 y q8_0)
del repo oficial de whisper.cpp, con sha256 verificado; cualquier
otra descarga se consulta antes (misma forma de trabajo que la nota
de delegación del ADR-012: autorizaciones acotadas, registradas).

Hoy tequio habla `POST /v1/chat/completions` con `input_audio`
(formato del gateway LFM3: Bearer + `X-Project-ID`).

## Decisión

1. **Artefacto de despliegue, no núcleo.** El servicio STT turbo es
   un componente que glosomata ENTREGA (`services/stt-turbo/`) y
   Malintzin DESPLIEGA en el Dell (systemd `--user`, tailnet,
   token). glosomata (CLI/MCP) SIGUE sin abrir servidor HTTP/socket
   (no-objetivo intacto, ADR-008): el servicio es infraestructura
   del consumidor, como el gateway LFM3 lo es del proveedor. La
   flota de glosomata gana después un ADAPTADOR STT que le HABLA
   por loopback/tailnet (precedentes `phonon_ollama`/`lfm3`:
   clientes locales a servicios ajenos al núcleo).
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
   script; sin hints, conducta actual) y REVISIÓN del tope de pared
   `diar_max_wall_s` para diarizar 2–4 h de una pasada en el Dell
   (el tope ya es configurable y el tope duro del schema es 86 400
   s; la revisión ajusta el DEFAULT documentado con las mediciones
   del Dell, no el contrato). Se ejecuta en rama propia con
   revisión.
8. **Descarga de modelos**: la ejecuta quien despliegue (Malintzin
   en el Dell; el Operador o su delegado en el Mac), bajo la
   autorización acotada; el servicio verifica sha256 antes de
   cargar (fail-closed). glosomata no descarga.

## Alternativas descartadas

- **STT efímero por petición**: recarga del modelo por tramo; con
  413 tramos por reunión es el problema, no la solución.
- **LFM3 para STT de tequio**: el Operador lo pospuso («nos vamos
  por turbo… para tequio usaremos turbo»); LFM3 conserva TTS.
- **whisper-server upstream desnudo**: no habla la forma
  `chat/completions`+`input_audio` que tequio ya usa; exige cambio
  de cliente (es la opción B con otro nombre).
- **El núcleo de glosomata abre el puerto**: reabriría el
  no-objetivo HTTP del núcleo que ADR-008 dejó intacto a propósito;
  el artefacto de despliegue lo evita con la misma frontera que el
  gateway LFM3.

## Consecuencias

- Nueva familia de artefactos `services/` en el repo: código de
  despliegue para terceros (Malintzin), no ejecutado por el núcleo;
  el gate de tamaños y la suite los tratan como código normal.
- La autorización de descarga queda REGISTRADA y ACOTADA aquí
  (turbo ggml q5_0/q8_0 oficial, sha256): cualquier otro modelo o
  instalación exige consulta previa (regla del Operador).
- Interfaz PENDIENTE de acuerdo: este ADR no se acepta hasta que el
  orquestador confirme A o B con tequio; el resto del diseño no
  depende de esa elección.
- Mediciones del Dell: observaciones, nunca cotas (regla vigente).
