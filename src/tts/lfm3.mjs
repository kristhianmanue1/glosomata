// Motor LFM3-Omni como boca (TTS): HTTP de loopback al gateway v2 del
// equipo mediante curl en subprocess. El texto viaja por stdin del curl;
// nunca en argv ni en logs. El ciclo de vida del gateway (8092) es
// decisión del Operador: este adaptador jamás lo arranca ni lo detiene.
// Contrato del proveedor: SPEC-i1-vs de LFM3-Omni-FK (voz fija es, WAV
// completo, 503 sin cola, input 1..600 sin controles); decisión local:
// ADR-011.

import { access, constants, writeFile } from 'node:fs/promises';
import { spawnGrupo, matarGrupo, stopPedido } from '../canal.mjs';

const CURL = '/usr/bin/curl';
const HOST = 'http://127.0.0.1:8092';
const MAX_CAPABILITIES = 256 * 1024;
const MAX_WAV = 16 * 1024 * 1024;
// SPEC-i1-vs §1: input de 1..600 caracteres; §2: el gateway mata la
// síntesis a los 120 s — esperar más allá de eso no tiene contrato.
const MAX_INPUT = 600;
const TIMEOUT_SINTESIS_S = 120;
const TIMEOUT_PROBE_S = 3;

function ttsError(cause) {
  const err = new Error('tts_failed');
  err.code = 'tts_failed';
  if (cause !== undefined) err.cause = cause;
  return err;
}

// El contrato del proveedor prohíbe caracteres de control (incluidos
// \n y \t) y exige al menos un imprimible no blanco. La canonización de
// glosomata NO elimina \n/\t/DEL, así que el adaptador rechaza ANTES de
// solicitar: fallar sin request es más honesto que un 400 que nadie
// lee. Códigos existentes de la taxonomía: la cota es `text_too_long`;
// el resto de la frontera de entrada del motor es `not_supported`.
const RE_CONTROL = /[\u0000-\u001f\u007f]/u;

function validarEntrada(texto) {
  // [...] itera code points: la cota del proveedor cuenta caracteres,
  // no unidades UTF-16.
  if ([...texto].length > MAX_INPUT) {
    throw Object.assign(new Error('text_too_long'), { code: 'text_too_long' });
  }
  if (texto.trim() === '' || RE_CONTROL.test(texto)) {
    throw Object.assign(new Error('not_supported'), { code: 'not_supported' });
  }
}

function curlArgs(path, timeoutS, post) {
  // -q primero: ignora .curlrc. URL fija y --noproxy: la síntesis no
  // sale del loopback por configuración de entorno. Sin --fail: el
  // veredicto es el código HTTP que el propio -w escribe al final.
  const args = ['-q', '--noproxy', '*', '--proto', '=http', '--max-redirs', '0',
    '--silent', '--show-error', '--max-time', String(timeoutS),
    '-w', '\n%{http_code}'];
  if (post) {
    args.push('--header', 'Content-Type: application/json',
      '--data-binary', '@-');
  }
  args.push(`${HOST}${path}`);
  return args;
}

// La respuesta viaja por stdout como CUERPO + '\n' + código (el -w).
// El corte usa el ÚLTIMO salto de línea: un WAV que termine en 0x0A no
// confunde la separación. Código de salida != 0 es fallo de transporte
// (conexión, timeout): tts_failed sin interpretar el cuerpo de error —
// su contenido se descarta, jamás se registra (política de logs).
function solicitar(bin, path, cuerpo, maxBytes, timeoutS, cancelable) {
  return new Promise((resolve, reject) => {
    const child = spawnGrupo(bin, curlArgs(path, timeoutS, cuerpo !== null));
    const chunks = [];
    let total = 0;
    let exceeded = false;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fn(value);
    };
    const poll = cancelable ? setInterval(() => {
      if (stopPedido()) matarGrupo(child);
    }, 50) : null;
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        exceeded = true;
        matarGrupo(child);
      } else {
        chunks.push(chunk);
      }
    });
    child.on('error', () => done(reject, ttsError()));
    child.on('close', (code) => {
      if (cancelable && stopPedido()) return done(resolve, 'stopped');
      if (code !== 0 || exceeded || total === 0) {
        return done(reject, ttsError(`exit ${code}`));
      }
      const salida = Buffer.concat(chunks, total);
      const corte = salida.lastIndexOf(0x0a);
      if (corte < 0) return done(reject, ttsError('salida sin código'));
      const codigo = salida.subarray(corte + 1).toString('ascii');
      if (!/^\d{3}$/.test(codigo)) {
        return done(reject, ttsError('código ilegible'));
      }
      done(resolve, { cuerpo: salida.subarray(0, corte), codigo });
    });
    child.stdin.end(cuerpo !== null ? JSON.stringify(cuerpo) : undefined);
  });
}

// Inyección limitada a pruebas de frontera de proceso. CLI/MCP siempre
// usan /usr/bin/curl; una matriz no puede sustituir el ejecutable.
export function createRequesterForTesting(bin) {
  return (path, cuerpo, maxBytes, timeoutS, cancelable) =>
    solicitar(bin, path, cuerpo, maxBytes, timeoutS, cancelable);
}

const request = createRequesterForTesting(CURL);

// Misma frontera que el gateway exige a llama-tts (SPEC-i1-vs §2) —
// RIFF/WAVE con muestras no vacías — y un grado más estricta: chunks
// ÍNTEGROS (un tamaño declarado mayor que los bytes recibidos falla
// cerrado; lecturas fuera del buffer jamás escalan como RangeError) y
// PCM 16-bit. Si el proveedor emitiera otro formato, glosomata falla
// cerrado antes que reproducirlo ciego.
function wavValido(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF'
    || wav.toString('ascii', 8, 12) !== 'WAVE') return false;
  let fmt = null;
  let data = null;
  let off = 12;
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4);
    const tam = wav.readUInt32LE(off + 4);
    // chunk truncado: la cabecera declara más de lo que llegó
    if (off + 8 + tam > wav.length) return false;
    if (id === 'fmt ' && tam >= 16) {
      fmt = {
        formato: wav.readUInt16LE(off + 8),
        canales: wav.readUInt16LE(off + 10),
        bits: wav.readUInt16LE(off + 22),
      };
    } else if (id === 'data') {
      data = tam;
    }
    off += 8 + tam + (tam % 2); // los chunks van alineados a 2 bytes
  }
  return fmt !== null && fmt.formato === 1 && fmt.bits === 16
    && fmt.canales >= 1 && data !== null && data > 0;
}

export async function diagnostico(cfg, requester = request) {
  // Reproducción local por afplay: sin macOS no hay playback (misma
  // frontera que phonon_ollama; el gateway es del Operador, el altavoz
  // es de esta máquina).
  if (process.platform !== 'darwin') {
    return { ok: false, causa: 'plataforma_no_soportada' };
  }
  try {
    await access('/usr/bin/afplay', constants.X_OK);
  } catch {
    return { ok: false, causa: 'afplay_ausente' };
  }
  try {
    await access(CURL, constants.X_OK);
  } catch {
    return { ok: false, causa: 'binario_ausente' };
  }
  if (cfg.bin !== undefined && cfg.bin !== CURL) {
    return { ok: false, causa: 'probe_fallido' };
  }
  try {
    const r = await requester('/v1/capabilities', null,
      MAX_CAPABILITIES, TIMEOUT_PROBE_S, false);
    if (r === 'stopped' || r.codigo !== '200') {
      return { ok: false, causa: 'probe_fallido' };
    }
    // capabilities declara la síntesis del gateway (SPEC-i1-vs §4):
    // sin `voz:true` el endpoint de síntesis no está contratado.
    const caps = JSON.parse(r.cuerpo.toString('utf8'));
    return caps?.voz === true ? { ok: true }
      : { ok: false, causa: 'probe_fallido' };
  } catch {
    return { ok: false, causa: 'probe_fallido' };
  }
}

export async function disponible(cfg) {
  return (await diagnostico(cfg)).ok;
}

// Exportada para verificar la frontera de proceso sin activar altavoces.
export async function sintetizar(cfg, texto, tmpWav, requester = request) {
  validarEntrada(texto);
  if (stopPedido()) return 'stopped';
  const r = await requester('/v1/audio/speech',
    { input: texto, response_format: 'wav' },
    MAX_WAV, TIMEOUT_SINTESIS_S, true);
  if (r === 'stopped' || stopPedido()) return 'stopped';
  // 503 overloaded (exclusión mutua, sin cola) y cualquier otro estado
  // son tts_failed: el consumidor decide su reintento acotado; este
  // adaptador no encola (el proveedor tampoco).
  if (r.codigo !== '200') throw ttsError(`http_${r.codigo}`);
  if (!wavValido(r.cuerpo)) throw ttsError('wav_invalido');
  await writeFile(tmpWav, r.cuerpo, { mode: 0o600 });
  return stopPedido() ? 'stopped' : 'ok';
}

export async function hablar(cfg, texto, { tmpWav }) {
  const synth = await sintetizar(cfg, texto, tmpWav);
  if (synth === 'stopped') return { played: false, echo: null, truncated: true };
  return new Promise((resolve, reject) => {
    const child = spawnGrupo('/usr/bin/afplay', [tmpWav]);
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      fn(value);
    };
    const poll = setInterval(() => {
      if (stopPedido()) matarGrupo(child);
    }, 50);
    child.on('error', () => done(reject,
      Object.assign(new Error('audio_device_error'), { code: 'audio_device_error' })));
    child.on('close', (code) => {
      if (stopPedido()) {
        return done(resolve, { played: false, echo: null, truncated: true });
      }
      if (code === 0) {
        return done(resolve, { played: true, echo: texto, truncated: false });
      }
      done(reject, Object.assign(new Error('audio_device_error'),
        { code: 'audio_device_error' }));
    });
  });
}
