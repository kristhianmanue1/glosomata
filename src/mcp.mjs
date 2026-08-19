// Servidor MCP v1 — stdio únicamente (ADR-round-2). Logs a stderr, jamás stdout.
// Contrato: docs/specs/specs-y-contratos-v1.md (§ MCP)

import { main } from './mcp-core.mjs';
import { instalarSenales } from './canal.mjs';

instalarSenales();

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`glosomata-mcp: ${err.code ?? err.message}\n`);
    process.exit(1);
  }
);
