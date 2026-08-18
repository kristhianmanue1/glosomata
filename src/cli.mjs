import { main } from './cli-core.mjs';
import { instalarSenales } from './canal.mjs';

instalarSenales();

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`glosomata: ${err.code ?? err.message}\n`);
    process.exit(1);
  }
);
