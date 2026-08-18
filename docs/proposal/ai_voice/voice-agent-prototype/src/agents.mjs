const MAX_MESSAGE_LENGTH = 2000;

export function validateMessage(value) {
  if (typeof value !== "string") {
    throw new TypeError("message debe ser texto");
  }

  const message = value.trim();
  if (!message) {
    throw new RangeError("message no puede estar vacío");
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(`message excede ${MAX_MESSAGE_LENGTH} caracteres`);
  }
  return message;
}

export function createDemoAgent() {
  return {
    name: "demo-agent",
    async respond(message) {
      return `Recibí su mensaje: ${message}. Esta es una respuesta de prueba.`;
    }
  };
}

export function createOllamaAgent({ baseUrl, model, fetchImpl = fetch }) {
  if (!model) {
    throw new Error("OLLAMA_MODEL es obligatorio para usar Ollama");
  }

  const endpoint = new URL("api/chat", `${baseUrl.replace(/\/$/, "")}/`);
  return {
    name: `ollama:${model}`,
    async respond(message, { signal } = {}) {
      const timeout = AbortSignal.timeout(45_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          options: { num_predict: 160 },
          messages: [{ role: "user", content: message }]
        }),
        signal: requestSignal
      });
      if (!response.ok) {
        throw new Error(`Ollama respondió HTTP ${response.status}`);
      }
      const payload = await response.json();
      const reply = payload?.message?.content;
      if (typeof reply !== "string" || !reply.trim()) {
        throw new Error("Ollama devolvió una respuesta vacía");
      }
      return reply.trim();
    }
  };
}

export function createAgent(env = process.env) {
  const provider = env.AGENT_PROVIDER || "ollama";
  if (provider === "demo") {
    return createDemoAgent();
  }
  if (provider === "ollama") {
    return createOllamaAgent({
      baseUrl: env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
      model: env.OLLAMA_MODEL || "qwen3:8b"
    });
  }
  throw new Error(`AGENT_PROVIDER no soportado: ${provider}`);
}
