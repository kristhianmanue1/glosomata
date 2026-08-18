# Sintetiza con kokoro-mlx y escribe WAV a la ruta indicada.
# Entrada: JSON por stdin {texto, voice, pitch_scale, out}.
# Salida: JSON {ok: true} o {ok: false, error: <codigo>}. El texto NUNCA
# se imprime (política de logs).

import sys
import json


def main():
    try:
        req = json.load(sys.stdin)
    except Exception:
        print(json.dumps({"ok": False, "error": "input_invalid"}))
        return 1
    texto = (req.get("texto") or "").strip()
    if not texto or len(texto) > 2000:
        print(json.dumps({"ok": False, "error": "text_too_long"}))
        return 1
    pitch = float(req.get("pitch_scale", 1.0))
    if not 0.8 <= pitch <= 1.2:
        print(json.dumps({"ok": False, "error": "pitch_invalid"}))
        return 1
    try:
        from kokoro_mlx import KokoroTTS
        with KokoroTTS.from_pretrained() as tts:
            tts.save(
                texto,
                req["out"],
                voice=req.get("voice", "em_alex"),
                sample_rate=24000,
            )
        if pitch != 1.0:
            import os
            import shutil
            import subprocess
            from pathlib import Path
            ffmpeg = shutil.which("ffmpeg") or "/opt/homebrew/bin/ffmpeg"
            if not Path(ffmpeg).is_file():
                print(json.dumps({"ok": False, "error": "ffmpeg_missing"}))
                return 1
            rate = round(24000 * pitch)
            tempo = 1 / pitch
            adjusted = f"{req['out']}.adjusted.wav"
            subprocess.run(
                [ffmpeg, "-y", "-loglevel", "error", "-i", req["out"],
                 "-af", f"asetrate={rate},aresample=24000,atempo={tempo:.8f}",
                 adjusted],
                check=True,
            )
            os.replace(adjusted, req["out"])
        print(json.dumps({"ok": True}))
        return 0
    except Exception:
        print(json.dumps({"ok": False, "error": "tts_failed"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
