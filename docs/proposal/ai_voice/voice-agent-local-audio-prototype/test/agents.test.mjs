import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgent,
  createDemoAgent,
  createOllamaAgent,
  validateMessage
} from "../src/agents.mjs";

test("normaliza un mensaje válido", () => {
  assert.equal(validateMessage("  hola  "), "hola");
});

test("rechaza mensajes vacíos y demasiado largos", () => {
  assert.throws(() => validateMessage("  "), RangeError);
  assert.throws(() => validateMessage("a".repeat(2001)), RangeError);
});

test("el agente demo se identifica y responde", async () => {
  const agent = createDemoAgent();
  assert.equal(agent.name, "demo-agent");
  assert.match(await agent.respond("hola"), /hola/);
});

test("falla cerrado ante un proveedor desconocido", () => {
  assert.throws(() => createAgent({ AGENT_PROVIDER: "desconocido" }), /no soportado/);
});

test("usa Ollama qwen3:8b como agente local predeterminado", () => {
  assert.equal(createAgent({}).name, "ollama:qwen3:8b");
});

test("el adaptador Ollama valida y extrae una respuesta", async () => {
  const calls = [];
  const agent = createOllamaAgent({
    baseUrl: "http://localhost:11434",
    model: "modelo-prueba",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ message: { content: "Respuesta local" } }));
    }
  });
  assert.equal(await agent.respond("hola"), "Respuesta local");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/chat$/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 160);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});
