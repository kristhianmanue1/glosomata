"""Adaptador mínimo de Kokoro MLX: texto UTF-8 a WAV local."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

from kokoro_mlx import KokoroTTS


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-file")
    parser.add_argument("--text")
    parser.add_argument("--output", required=True)
    parser.add_argument("--voice", default="em_alex")
    parser.add_argument("--pitch-scale", type=float, default=0.9)
    args = parser.parse_args()
    if bool(args.text_file) == bool(args.text):
        raise SystemExit("Use exactamente --text-file o --text")
    text = (Path(args.text_file).read_text(encoding="utf-8")
            if args.text_file else args.text).strip()
    if not text:
        raise SystemExit("Texto vacío")
    if not 0.8 <= args.pitch_scale <= 1.2:
        raise SystemExit("pitch-scale debe estar entre 0.8 y 1.2")
    with KokoroTTS.from_pretrained() as tts:
        tts.save(text, args.output, voice=args.voice, sample_rate=24000)
    if args.pitch_scale != 1.0:
        ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
        if not Path(ffmpeg).is_file():
            raise SystemExit("No se encontró FFmpeg para ajustar el tono")
        adjusted = f"{args.output}.adjusted.wav"
        rate = round(24000 * args.pitch_scale)
        tempo = 1 / args.pitch_scale
        subprocess.run([
            ffmpeg, "-y", "-loglevel", "error", "-i", args.output,
            "-af", f"asetrate={rate},aresample=24000,atempo={tempo:.8f}", adjusted
        ], check=True)
        os.replace(adjusted, args.output)


if __name__ == "__main__":
    main()
