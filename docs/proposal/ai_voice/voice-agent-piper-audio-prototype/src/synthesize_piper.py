"""Adaptador Piper: voz mexicana local a WAV con tono opcional."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import wave

from piper import PiperVoice


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", default="es_MX-claude-high")
    parser.add_argument("--pitch-scale", type=float, default=1.0)
    parser.add_argument("--data-dir", default="models")
    args = parser.parse_args()
    text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text or not 0.8 <= args.pitch_scale <= 1.2:
        raise SystemExit("Texto o pitch-scale inválido")
    model = Path(args.data_dir) / f"{args.voice}.onnx"
    with wave.open(args.output, "wb") as output:
        PiperVoice.load(model).synthesize_wav(text, output)
    if args.pitch_scale != 1.0:
        adjusted = f"{args.output}.adjusted.wav"
        with wave.open(args.output, "rb") as source:
            rate = source.getframerate()
        ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", args.output,
                        "-af", f"asetrate={round(rate * args.pitch_scale)},aresample={rate},atempo={1 / args.pitch_scale:.8f}", adjusted], check=True)
        os.replace(adjusted, args.output)


if __name__ == "__main__":
    main()
