// Fixture de señales: instala el contrato de señales del canal y queda
// en reposo (como el servidor MCP esperando stdin). No usa motores.
import { instalarSenales } from '../../src/canal.mjs';

instalarSenales();
process.stdin.resume();
process.stdout.write('listo\n');
