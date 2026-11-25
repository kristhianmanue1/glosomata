#!/usr/bin/env python3
"""Diarización efímera con pyannote community-1 (D2, ADR-012).

Contrato con src/diar.mjs (contrato-diarizacion-v1.md §4):

- argv: <este-script> <pipeline_dir> <audio_ruta> <max_duration_s>
  <embeddings:0|1> <device:cpu|cuda|mps> <min_speakers:0|N>
  <max_speakers:0|N> — SIN contenido: sólo rutas, el tope de
  duración (H-1, issue #43), el modo de huellas (enmienda
  2026-11-17), el dispositivo de cómputo (petición 2026-11-21:
  default cpu; si el pedido no está disponible vuelve a CPU y el
  dispositivo EFECTIVO viaja en la salida como "device") y los
  hints de rango de hablantes (v1.7, enmienda 2026-11-24: '0' es
  centinela de AUSENTE; glosomata YA validó — defensa en
  profundidad: este script re-valida el mismo rango).
- Entorno: EXIGE PYANNOTE_METRICS_ENABLED=0 y HF_HUB_OFFLINE=1 (los
  fija glosomata; si no llegan, este script rehúsa — fail-closed, la
  telemetría OFF es decisión del Operador, no un deseo).
- stdout: UN objeto JSON {"device": usado, "turns": [...]} y, con
  embeddings=1, además {"embeddings": {"<etiqueta cruda>":
  [floats, ...]}} — el CENTROIDE por hablante que el pipeline ya
  calcula al clusterizar (DiarizeOutput.speaker_embeddings,
  alineado a labels()). Nada más sale por stdout. stderr es
  humano/descartado. Las huellas son un DATO BIOMÉTRICO: jamás se
  escriben a disco ni logs (sólo stdout).
- NO escribe artefactos de datos (ni RTTM, ni WAV, ni resultados).
- Exit codes: 0 ok · 3 audio_ilegible (no existe, ilegible, vacío o
  sin duración decodificable) · 4 audio_demasiado_largo · 2 mal uso
  (argv inesperado o entorno sin las dos variables) · otro fallo.

La carga del pipeline es por RUTA LOCAL (espejo del Operador): este
script jamás descarga pesos ni toca la red. Sin modelos nuevos para
las huellas: son las del propio pipeline (subfolder embedding,
WeSpeaker 256-d en community-1).
"""

import json
import os
import re
import sys


def mal_uso(mensaje: str) -> None:
    # stderr es descartado por glosomata: sólo para depuración manual
    print(mensaje, file=sys.stderr)
    sys.exit(2)


def hint_hablantes(arg: str) -> "int | None":
    # Hints de rango (v1.7, enmienda 2026-11-24): '0' = AUSENTE
    # (centinela del contrato §4); N = entero ≥ 1 en decimal
    # estricto. Defensa en profundidad: glosomata YA rechazó todo
    # esto en la CLI — el script re-valida y rehúsa (exit 2) sin
    # confiar en su llamador.
    if arg == "0":
        return None
    if not re.fullmatch(r"[1-9][0-9]*", arg):
        mal_uso("hint de hablantes debe ser 0 (ausente) o entero >= 1")
    return int(arg)


def main() -> None:
    # sys.argv NO incluye al intérprete: [script, pipeline, audio, max,
    # embeddings, device, min, max] son OCHO elementos (contrato §4:
    # 9 tokens a nivel OS).
    if len(sys.argv) != 8:
        mal_uso(
            "uso: diarize_pyannote.py <pipeline_dir> <audio> "
            "<max_duration_s> <embeddings:0|1> <device:cpu|cuda|mps> "
            "<min_speakers:0|N> <max_speakers:0|N>"
        )
    _, pipeline_dir, audio_ruta, max_dur_arg, emb_arg, dev_arg, \
        min_arg, max_arg = sys.argv

    # Fail-closed sobre el entorno exigido (contrato §4/ADR-012).
    if os.environ.get("PYANNOTE_METRICS_ENABLED") != "0":
        mal_uso("PYANNOTE_METRICS_ENABLED debe ser 0")
    if os.environ.get("HF_HUB_OFFLINE") != "1":
        mal_uso("HF_HUB_OFFLINE debe ser 1")

    if emb_arg not in ("0", "1"):
        mal_uso("embeddings debe ser 0 o 1")
    con_huellas = emb_arg == "1"

    if dev_arg not in ("cpu", "cuda", "mps"):
        mal_uso("device debe ser cpu, cuda o mps")

    # Hints de rango (v1.7): defensa en profundidad, MISMO rango que
    # la CLI — re-validar aquí mantiene fail-closed aunque el
    # llamador cambie.
    min_speakers = hint_hablantes(min_arg)
    max_speakers = hint_hablantes(max_arg)
    if (
        min_speakers is not None
        and max_speakers is not None
        and min_speakers > max_speakers
    ):
        mal_uso("min_speakers no puede exceder a max_speakers")

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

    # CUARENTENA DE STDOUT (hallazgo B1, ronda r3): librerías nativas
    # (clustering VBx) pueden escribir warnings DIRECTO a fd 1 —
    # p. ej. «WARNING: Value of auxiliary function has decreased!» en
    # mps — y corromper el JSON del protocolo. Durante la carga y la
    # inferencia, fd 1 apunta a fd 2 (stderr, que glosomata drena);
    # el JSON se emite por el fd 1 original, restaurado después.
    _stdout_real = os.dup(1)
    os.dup2(2, 1)
    try:
        pipeline = Pipeline.from_pretrained(pipeline_dir)

        # Dispositivo de cómputo (petición 2026-11-21): default cpu; si
        # el pedido no está disponible se VUELVE a cpu sin caerse — el
        # dispositivo EFECTIVO viaja en la salida ("device") y por
        # stderr va un aviso humano (sin contenido: sólo nombres de
        # hardware).
        dispositivo = dev_arg
        if dispositivo != "cpu":
            import torch

            disponible = (
                torch.cuda.is_available() if dispositivo == "cuda"
                else torch.backends.mps.is_available()
            )
            if not disponible:
                print(
                    f"diarize: {dispositivo} no disponible; usando cpu",
                    file=sys.stderr,
                )
                dispositivo = "cpu"
            else:
                pipeline.to(torch.device(dispositivo))

        # Hints de rango (v1.7, enmienda 2026-11-24): viajan como
        # min_speakers=/max_speakers= (None = ausente; ambos None es
        # la conducta de siempre: min 1 / max infinito internos).
        # Semántica del motor (declarada en el contrato §2/§9.7): NO
        # guían el clustering VBx — corre automático y, si el conteo
        # queda FUERA del rango, re-clusteriza con K-Means forzado a
        # la cota y recalcula los centroides. num_speakers NO se
        # pasa (sólo rango).
        salida = pipeline(
            audio_ruta,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
        )
    finally:
        sys.stdout.flush()
        # búferes de libc (H1 r4): una librería C puede tener stdout
        # pendiente SIN fflush — se vuelca al salir, DESPUÉS del
        # JSON, por el fd restaurado. Con fd 1 aún apuntando a fd 2,
        # fflush(None) manda ese residuo al stderr drenado.
        import ctypes

        ctypes.CDLL(None).fflush(None)
        os.dup2(_stdout_real, 1)
        os.close(_stdout_real)

    turnos = []
    for turno, hablante in salida.exclusive_speaker_diarization:
        turnos.append(
            {
                "speaker": str(hablante),
                "start_s": float(turno.start),
                "end_s": float(turno.end),
            }
        )

    resultado = {"device": dispositivo, "turns": turnos}

    if con_huellas:
        # Centroides por hablante que el clustering ya calculó:
        # speaker_embeddings es (num_speakers, dim) en el orden de
        # speaker_diarization.labels(). Se FILTRAN a las etiquetas con
        # al menos un turno EXCLUSIVO (un hablante totalmente
        # solapado no aparece en los turnos: sin huella que los
        # cubra, la cobertura exacta de glosomata fallaría toda la
        # llamada — hallazgo H3 r1) y se emiten crudos (glosomata
        # canóniza). Dato biométrico: sólo stdout.
        con_turno = {t["speaker"] for t in turnos}
        etiquetas = [str(e) for e in salida.speaker_diarization.labels()
                     if str(e) in con_turno]
        indice = {str(e): i for i, e in enumerate(
            salida.speaker_diarization.labels())}
        huellas = salida.speaker_embeddings
        if huellas is None or any(e not in indice for e in etiquetas):
            print("huellas incoherentes con las etiquetas", file=sys.stderr)
            sys.exit(1)
        resultado["embeddings"] = {
            etiqueta: [float(x) for x in huellas[indice[etiqueta]]]
            for etiqueta in etiquetas
        }

    json.dump(resultado, sys.stdout)
    sys.stdout.flush()
    sys.exit(0)


if __name__ == "__main__":
    main()
