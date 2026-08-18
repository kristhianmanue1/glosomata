import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent, validateMessage } from "./agents.mjs";

const ROOT = fileURLToPath(new URL("../public/", import.meta.url));
const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"]
]);

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) {
      throw new RangeError("solicitud demasiado grande");
    }
  }
  return JSON.parse(body || "{}");
}

async function serveFile(request, response) {
  const requested = new URL(request.url, "http://localhost").pathname;
  const relative = requested === "/" ? "index.html" : requested.slice(1);
  const safePath = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(404).end();
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, {
      "content-type": MIME.get(extname(filePath)) || "application/octet-stream",
      "cache-control": "no-store"
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("No encontrado");
  }
}

export function createAppServer({ agent = createAgent() } = {}) {
  return createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/api/respond") {
      try {
        const payload = await readJson(request);
        const message = validateMessage(payload.message);
        const reply = await agent.respond(message);
        sendJson(response, 200, { reply, agent: agent.name });
      } catch (error) {
        const clientError = error instanceof TypeError ||
          error instanceof RangeError || error instanceof SyntaxError;
        sendJson(response, clientError ? 400 : 502, {
          error: clientError ? "invalid_request" : "agent_unavailable",
          message: clientError ? error.message : "El agente no está disponible."
        });
      }
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { allow: "GET, HEAD, POST" }).end();
      return;
    }
    await serveFile(request, response);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080);
  const server = createAppServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`Voice Agent Prototype: http://localhost:${port}`);
  });
}
