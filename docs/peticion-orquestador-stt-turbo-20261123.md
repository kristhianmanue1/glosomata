# Petición del orquestador → glosomata-capitan: motor STT Whisper large-v3-turbo para tequio (2026-11-23)

## Autoridad (Operador, literal)

> «nos vamos por turbo glosmata tendra tambien LFM3 pero para tequio usaremos turbo en su controtato asi que podemos solo cargar turbo»

- La comparativa LFM3 frente a turbo queda pospuesta.
- **Descarga autorizada:** sólo Whisper large-v3-turbo en ggml (q5_0 y q8_0) del repo oficial de whisper.cpp, con sha256 verificado. Cualquier otra descarga o instalación se consulta antes.

## Qué pide tequio

tequio envía **muchos tramos cortos** (unos 19 s de media; 413 en una reunión de 2 h) mientras graba.

- El motor tiene que estar **residente**: modelo cargado una sola vez, por ejemplo con `whisper-server` de whisper.cpp o un servicio tuyo.
- No vale un proceso efímero por petición.

## Qué entregas

1. **Diseño corto**, como ADR o enmienda de ADR-002:
   - adaptador STT turbo en la flota;
   - build de whisper.cpp con CUDA para el Dell (Linux, RTX 2060 de 6 GB) y Metal en el Mac;
   - un lock con hashes, como el de R-1.
2. **Interfaz HTTP del servicio.** Hoy tequio habla `POST /v1/chat/completions` con `input_audio` (formato del gateway LFM3, Bearer y `X-Project-ID`).
   - **Preferido:** exponer esa misma forma, para que tequio sólo cambie la URL.
   - **Si no conviene:** propón `POST /v1/audio/transcriptions`, con su coste para tequio.
   - **Acuérdalo con tequio-capitan-opus** a través de mí.
3. **Antialucinación:**
   - VAD (Silero, que ya tienes) o umbrales `no_speech`;
   - `audio_ctx` o una técnica equivalente para tramos de menos de 30 s;
   - **mide** lo que gana.
4. **Medición sintética en el Dell, sin audio real:**
   - VRAM residente;
   - tiempo por tramo (mediana y p95);
   - VRAM con una diarización pyannote a la vez.
5. **Contrato `diarize`:**
   - admitir `min_speakers`/`max_speakers` si aún no lo hace;
   - revisar el tope de pared de 7 200 s para diarizar 2–4 h de una pasada en el Dell.
6. **LFM3 sigue en glosomata** para sus usos (TTS, ADR-011). Esto no lo cambia.

## Reglas

- Revisión de otra familia con la regla de cierre.
- Pruebas sólo con audio sintético.
- Coordina las pruebas de GPU en el Dell con Malintzin y conmigo, fuera de las reuniones del Operador.
- Malintzin despliega y publica el servicio en el Dell (systemd `--user`, tailnet, token). Tú entregas el artefacto, el lock y la guía.

## Cierre

`FIN glosomata-stt-turbo <sha>`, con las cifras medidas, o `BLOQ` con tu recomendación.
