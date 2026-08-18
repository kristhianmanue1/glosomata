import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAppServer } from "../src/server.mjs";

async function withServer(agent, run, localAudio) {
  const server = createAppServer({ agent, localAudio });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("sirve la página principal", async () => {
  await withServer({ name: "test", respond: async () => "ok" }, async (base) => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Conversación local con voz/);
  });
});

test("transcribe y sintetiza sólo a través del adaptador local", async () => {
  const localAudio = {
    limits: { maxAudioBytes: 1024 },
    async transcribe(audio, contentType) {
      assert.equal(contentType, "audio/wav");
      assert.deepEqual(audio, Buffer.from("wav"));
      return { text: "Hola local", language: "es" };
    },
    async synthesize(text) {
      assert.equal(text, "Hola local");
      return Buffer.from("RIFF....WAVE");
    }
  };
  await withServer({ name: "test", respond: async () => "ok" }, async (base) => {
    const transcription = await fetch(`${base}/api/transcribe`, {
      method: "POST", headers: { "content-type": "audio/wav" }, body: "wav"
    });
    assert.deepEqual(await transcription.json(), { text: "Hola local", language: "es" });
    const speech = await fetch(`${base}/api/synthesize`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hola local" })
    });
    assert.equal(speech.headers.get("content-type"), "audio/wav");
    assert.deepEqual(Buffer.from(await speech.arrayBuffer()), Buffer.from("RIFF....WAVE"));
  }, localAudio);
});

test("entrega el mensaje al agente y devuelve texto", async () => {
  const received = [];
  const agent = {
    name: "test-agent",
    async respond(message) {
      received.push(message);
      return "Respuesta comprobada";
    }
  };
  await withServer(agent, async (base) => {
    const response = await fetch(`${base}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hola agente" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      reply: "Respuesta comprobada",
      agent: "test-agent"
    });
    assert.deepEqual(received, ["Hola agente"]);
  });
});

test("un fallo del agente no se presenta como éxito", async () => {
  const agent = {
    name: "fallido",
    async respond() {
      throw new Error("detalle privado");
    }
  };
  await withServer(agent, async (base) => {
    const response = await fetch(`${base}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Hola" })
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: "agent_unavailable",
      message: "El agente no está disponible."
    });
  });
});
