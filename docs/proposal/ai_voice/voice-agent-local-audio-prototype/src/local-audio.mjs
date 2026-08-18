import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { validateMessage } from "./agents.mjs";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 45;
const MAX_SPEECH_CHARS = 2_000;

export class LocalAudioError extends Error {}

export function validateAudio(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TypeError("El audio está vacío.");
  }
  if (buffer.length > MAX_AUDIO_BYTES) {
    throw new RangeError("El audio supera 8 MB.");
  }
  if (contentType !== "audio/wav") {
    throw new TypeError("Sólo se acepta audio WAV local.");
  }
  return buffer;
}

function run(command, args, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new LocalAudioError(`No se pudo iniciar ${basename(command)}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new LocalAudioError(
        signal ? `${basename(command)} excedió el tiempo disponible.` :
          `${basename(command)} terminó con error.`
      ));
    });
  });
}

async function inTemporaryDirectory(work) {
  const directory = await mkdtemp(join(tmpdir(), "glosomata-audio-"));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function createLocalAudio({
  whisperBin = process.env.WHISPER_BIN || "whisper-cli",
  whisperModel = process.env.WHISPER_MODEL || "models/ggml-small.bin",
  kokoroPython = process.env.KOKORO_PYTHON || "python3",
  kokoroScript = process.env.KOKORO_SCRIPT || "src/synthesize_kokoro.py",
  voice = process.env.KOKORO_VOICE || "em_alex",
  pitchScale = process.env.KOKORO_PITCH_SCALE || "0.9",
  runCommand = run
} = {}) {
  return {
    async transcribe(buffer, contentType) {
      validateAudio(buffer, contentType);
      return inTemporaryDirectory(async (directory) => {
        const input = join(directory, `${randomUUID()}.wav`);
        const outputBase = join(directory, "transcript");
        await writeFile(input, buffer);
        await runCommand(whisperBin, [
          "-m", whisperModel, "-l", "es", "-nt", "-otxt", "-of", outputBase, input
        ], { timeoutMs: 45_000 });
        const text = (await readFile(`${outputBase}.txt`, "utf8")).trim();
        if (!text) throw new LocalAudioError("Whisper no devolvió texto.");
        return { text: validateMessage(text), language: "es" };
      });
    },
    async synthesize(text) {
      const cleanText = validateMessage(text);
      if (cleanText.length > MAX_SPEECH_CHARS) {
        throw new RangeError("El texto supera el límite de síntesis.");
      }
      return inTemporaryDirectory(async (directory) => {
        const textPath = join(directory, "reply.txt");
        const output = join(directory, "reply.wav");
        await writeFile(textPath, cleanText, "utf8");
        await runCommand(kokoroPython, [
          kokoroScript, "--text-file", textPath, "--output", output, "--voice", voice,
          "--pitch-scale", String(pitchScale)
        ], { timeoutMs: 45_000 });
        const audio = await readFile(output);
        if (audio.length < 44) throw new LocalAudioError("Kokoro no produjo audio válido.");
        return audio;
      });
    },
    limits: { maxAudioBytes: MAX_AUDIO_BYTES, maxAudioSeconds: MAX_AUDIO_SECONDS }
  };
}
