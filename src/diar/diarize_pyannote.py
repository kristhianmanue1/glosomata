#!/usr/bin/env python3
"""Diarización efímera con pyannote community-1 (D2, ADR-012).

Contrato con src/diar.mjs (contrato-diarizacion-v1.md §4):

- argv: <este-script> <pipeline_dir> <audio_ruta> <max_duration_s>
  — SIN contenido: sólo rutas y el tope de duración (H-1, issue #43).
- Entorno: EXIGE PYANNOTE_METRICS_ENABLED=0 y HF_HUB_OFFLINE=1 (los
  fija glosomata; si no llegan, este script rehúsa — fail-closed, la
  telemetría OFF es decisión del Operador, no un deseo).
- stdout: UN objeto JSON {"turns": [{"speaker", "start_s", "end_s"}]}
  con la diarización EXCLUSIVA (labels crudas; glosomata canóniza).
  Nada más sale por stdout. stderr es humano/descartado.
- NO escribe artefactos de datos (ni RTTM, ni WAV, ni resultados).
- Exit codes: 0 ok · 3 audio_ilegible (no existe, ilegible, vacío o
  sin duración decodificable) · 4 audio_demasiado_largo · 2 mal uso
  (argv inesperado o entorno sin las dos variables) · otro fallo.

La carga del pipeline es por RUTA LOCAL (espejo del Operador): este
script jamás descarga pesos ni toca la red. Verificación física
pendiente del ensayo vivo D3 (autorización expresa del Operador).
"""

import json
import os
import sys


def mal_uso(mensaje: str) -> None:
    # stderr es descartado por glosomata: sólo para depuración manual
    print(mensaje, file=sys.stderr)
    sys.exit(2)


def main() -> None:
    if len(sys.argv) != 5:
        mal_uso(
            "uso: diarize_pyannote.py <pipeline_dir> <audio> "
            "<max_duration_s>"
        )
    _, pipeline_dir, audio_ruta, max_dur_arg = sys.argv

    # Fail-closed sobre el entorno exigido (contrato §4/ADR-012).
    if os.environ.get("PYANNOTE_METRICS_ENABLED") != "0":
        mal_uso("PYANNOTE_METRICS_ENABLED debe ser 0")
    if os.environ.get("HF_HUB_OFFLINE") != "1":
        mal_uso("HF_HUB_OFFLINE debe ser 1")

    try:
        max_dur_s = float(max_dur_arg)
    except ValueError:
        mal_uso("max_duration_s no numérico")

    # Sonda de audio ANTES de inferir (H-1): existencia, lectura,
    # tamaño y duración decodificable. La duración permite rechazar
    # temprano (exit 4) sin cargar el pipeline.
    if not os.path.isfile(audio_ruta) or not os.access(audio_ruta, os.R_OK):
        sys.exit(3)  # audio_ilegible
    if os.path.getsize(audio_ruta) == 0:
        sys.exit(3)  # audio_ilegible

    try:
        from pyannote.audio.core.io import Audio
    except Exception:
        print("pyannote.audio no disponible", file=sys.stderr)
        sys.exit(1)

    try:
        duracion = Audio().get_duration(audio_ruta)
    except Exception:
        # sonda de decodificación rota: sin base para distinguir
        # "audio malo" de otra cosa — audio_ilegible, sin especular
        sys.exit(3)
    if not (duracion > 0):
        sys.exit(3)
    if duracion > max_dur_s:
        sys.exit(4)  # audio_demasiado_largo

    # Carga e inferencia locales. Cualquier fallo aquí es del motor,
    # no del audio: exit != {0,3,4} → inferencia_fallida en glosomata.
    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(pipeline_dir)
    salida = pipeline(audio_ruta)

    turnos = []
    for turno, hablante in salida.exclusive_speaker_diarization:
        turnos.append(
            {
                "speaker": str(hablante),
                "start_s": float(turno.start),
                "end_s": float(turno.end),
            }
        )

    json.dump({"turns": turnos}, sys.stdout)
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
