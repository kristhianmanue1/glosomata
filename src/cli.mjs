import { main } from './cli-core.mjs';
import { instalarSenales } from './canal.mjs';

instalarSenales();

// NUNCA process.exit() desde el then: con stdout en TUBERÍA las
// escrituras son asíncronas y exit() corta el volcado a los ~64 KiB
// del búfer (defecto visto con diarize --embeddings sobre un tramo de
// 1 800 s: JSON truncado e inválido por tubería, válido a archivo).
// Se fija exitCode y el proceso termina SOLO cuando el bucle drena
// stdout/stderr — el código de salida del contrato se conserva.
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code ?? 0;
  },
  (err) => {
    process.stderr.write(`glosomata: ${err.code ?? err.message}\n`);
    process.exitCode = 1;
  }
);
