# ADR-013: fin de turno de `listen` por silencio y por voz humana (Silero VAD)

Estado: aceptado. Registra una decisión ya ejecutada: el Operador ordenó
integrar los cambios por escrito («fusiona el PR 52», «fusiona el PR 53»,
2026-11-13) después de probarlos en vivo. Este ADR salda la deuda que
declaraba «No objetivos v1»: «VAD/barge-in (candidato v1.1 con ADR
propio)» (issue #54, C3).

## Contexto

Hasta el 2026-11-13, `listen` capturaba una ventana fija de `--timeout`
segundos: la voz no cortaba la captura. En una conversación por voz real
entre un agente y el Operador, el turno duraba siempre el tope (32 s con
`--timeout 30`), aunque el Operador hubiera terminado de hablar a los
pocos segundos.

Un primer corte por volumen (RMS) resolvió el caso de una sala silenciosa,
pero se medía mal en dos situaciones:

- **Tono de turno**: el Operador habla en cuanto suena el tono, así que
  calibrar el piso de ruido con los primeros 300 ms medía su voz (piso
  1576 → umbral 4978 con una voz de pico 1576). Nunca cortaba.
- **Música o ruido que fluctúa**: el volumen no distingue la voz de la
  música; el silencio del humano no llegaba a verse (turno de 53 s con
  `[Música]`).

## Decisión

1. `--timeout` pasa a ser el **tope** de la captura, no su duración.
2. **Detector por volumen** (siempre disponible, sin dependencias): piso
   de ruido = percentil 10 de todo lo escuchado, umbral = 2.5× piso + 150,
   y corte tras 1.5 s de silencio posterior a la voz. Sin voz detectada no
   corta: rige el tope y `mic_timeout`, como antes (PR #50, #51).
3. **Silero VAD opcional** (PR #52): con `engines.stt.vad_bin` (whisper.cpp
   `whisper-vad-speech-segments`) y `vad_model` (ggml Silero v6.2.0)
   declarados, decide la **voz humana**. Cada 500 ms evalúa una ventana con
   los últimos 6 s (`-vspd 100`) y corta 1.5 s después del último segmento
   de voz. La música y el ruido no cuentan como voz.
4. **Fail-safe**: si el VAD no está declarado, no existe o falla, rige el
   detector por volumen. El VAD jamás corta por error. Si cortó el VAD, la
   puerta RMS de silencio no emite `mic_timeout`.
5. **Diagnóstico** (PR #53): `config validate` y `doctor` informan
   `stt.vad`. Un VAD declarado y roto tumba el veredicto, con el mismo
   criterio que diar (causas `vad_parcial | vad_bin_ausente |
   vad_model_ausente`).
6. **Tono de turno** en darwin (`Tink.aiff`) antes de abrir el micrófono;
   `GLOSOMATA_TONO` lo cambia o lo apaga (PR #51).

## Alternativas descartadas

- **Ventana fija** (conducta previa): el humano espera el tope en cada
  turno.
- **Solo el detector por volumen**: falla con música; por eso el VAD.
- **VAD de pyannote** (ya está en `.venv-diar`): torch y segundos de carga
  por evaluación; Silero ggml tarda 16 ms por 7 s de audio.
- **Evaluar todo lo capturado** cada 500 ms: coste O(N²) en un turno de
  120 s (revisión r1); se usa una ventana de 6 s.
- **Barge-in** (que el humano interrumpa a `speak`): sigue fuera de v1.

## Consecuencias

- La semántica de `listen` cambia para CLI y MCP por igual (comparten
  `ops.listenOp`). Los consumidores no deben prometer «habla al menos N
  segundos»: el turno termina con el silencio del humano.
- El modelo Silero se instala por el Operador: glosomata jamás descarga
  pesos. El archivo local `for-tests-silero-v6.2.0-ggml.bin` es idéntico al
  oficial `ggml-silero-v6.2.0.bin` (sha256 `2aa269b7…6987`, 885098 bytes).
- El VAD escribe un temporal `<tmp>.vad.wav` (0600, en runtime 0700) que se
  borra al cerrar la captura; `cerrar()` mata el proceso VAD en vuelo y lo
  espera, con un tope de 250 ms. Los fallos de SIGKILL o SIGTERM quedan
  bajo el barrido de 60 s, igual que el WAV de captura.
- Con música sola y sin voz, el VAD no corta: rige el tope.

## Evidencia

- `docs/hallazgos-2026-11-13-prueba-voz-conversacion.md` (mediciones en
  vivo).
- Revisiones adversariales: PR #52, r1 Gemini (`fix-and-retry`, 2 HIGH
  corregidos) y r2 DeepSeek (`proceed`); PR #53, r1 y r2 DeepSeek
  (`proceed` en r2).
- Pruebas: `tests/stt.test.mjs` (detector, traza RMS real, VAD) y
  `tests/vad.test.mjs` (cierre, limpieza y fallback, con control negativo).
