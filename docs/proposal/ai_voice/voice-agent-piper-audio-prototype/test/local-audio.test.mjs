import test from "node:test";
import assert from "node:assert/strict";
import { validateAudio } from "../src/local-audio.mjs";

test("la entrada de voz exige WAV y contenido", () => {
  assert.throws(() => validateAudio(Buffer.alloc(0), "audio/wav"), /vacío/);
  assert.throws(() => validateAudio(Buffer.from("audio"), "audio/webm"), /WAV/);
  assert.deepEqual(validateAudio(Buffer.from("audio"), "audio/wav"), Buffer.from("audio"));
});
