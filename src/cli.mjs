import { main } from './cli-core.mjs';

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    process.stderr.write(`glosomata: ${err.message}\n`);
    process.exit(1);
  }
);
