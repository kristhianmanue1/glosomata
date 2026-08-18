// Servidor MCP v1 — stdio únicamente (ADR-round-2). Logs a stderr, jamás stdout.
// Contrato: docs/specs/contrato-mcp.md

import { main } from './mcp-core.mjs';

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`glosomata-mcp: ${err.message}\n`);
    process.exit(1);
  }
);
