// D1 de diarización (ADR-012): schema engines.diar + constraints,
// probe estructural diagnosticoDiar, wiring de doctor y de
// config validate/set. Expectaciones leídas del contrato
// docs/specs/contrato-diarizacion-v1.md (§3.1/§6/§7), no del código.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync,
  readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { validar } from '../src/schema.mjs';
import { diagnosticoDiar } from '../src/diar.mjs';

const CLI = 'src/cli.mjs';
const CWD = new URL('..', import.meta.url).pathname;

const schema = JSON.parse(await readFile(
  new URL('../docs/schemas/glosomata-config-v1.schema.json', import.meta.url),
  'utf8'));

// —— fixtures de filesystem: python/script/pipeline falsos (hermético:
// jamás se ejecuta nada; el probe es estructural) ——

const dirFix = mkdtempSync(join(tmpdir(), 'glosomata-diar-'));
const fixPython = join(dirFix, 'python');
const fixScript = join(dirFix, 'diarize_pyannote.py');
const fixPipeline = join(dirFix, 'pipeline');
writeFileSync(fixPython, '');
writeFileSync(fixScript, '');
mkdirSync(fixPipeline);
writeFileSync(join(fixPipeline, 'config.yaml'), '');

const DIAR_SANO = { python: fixPython, script: fixScript,
  pipeline: fixPipeline };

// —— D2: falso python (hermético: registra argv/env y emite conductas
// del contrato §4; jamás toca pyannote ni el disco del audio) ——

const dirFalso = mkdtempSync(join(tmpdir(), 'glosomata-diar-fake-'));
const FALSO_PY = join(dirFalso, 'fake-diar-python');
writeFileSync(FALSO_PY, `#!/usr/bin/env node
const fs = require('node:fs');
const modo = process.env.GLOSOMATA_DIAR_FAKE_MODE ?? 'ok';
const log = process.env.GLOSOMATA_DIAR_FAKE_LOG;
if (log) fs.writeFileSync(log, JSON.stringify({
  argv: process.argv.slice(2),
  PYANNOTE_METRICS_ENABLED: process.env.PYANNOTE_METRICS_ENABLED,
  HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE,
}));
const salir = (c) => process.exit(c);
const emitir = (o) => { process.stdout.write(JSON.stringify(o)); salir(0); };
const modos = {
  ok: () => emitir({ turns: [
    { speaker: 'voz_b', start_s: 1.5, end_s: 2.5 },
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
    { speaker: 'voz_b', start_s: 3, end_s: 4 },
  ] }),
  ilegible: () => salir(3),
  largo: () => salir(4),
  crash: () => salir(1),
  basura: () => { process.stdout.write('esto no es json'); salir(0); },
  solape: () => emitir({ turns: [
    { speaker: 'x', start_s: 0, end_s: 2 },
    { speaker: 'y', start_s: 1, end_s: 3 },
  ] }),
  plano: () => emitir({ turns: [{ speaker: 'x', start_s: 1, end_s: 1 }] }),
  lento: () => setTimeout(() => emitir({ turns: [] }), 30000),
};
(modos[modo] ?? (() => salir(1)))();
`);
chmodSync(FALSO_PY, 0o755);

const DIAR_FALSO = { python: FALSO_PY, script: fixScript,
  pipeline: fixPipeline };
const AUDIO_X = join(dirFalso, 'reunion.wav');
writeFileSync(AUDIO_X, 'audio-falso');

function configDiarizable(constraints) {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = DIAR_FALSO;
  if (constraints !== undefined) cfg.constraints = constraints;
  return cfg;
}

function configTemporal(contenido) {
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-diar-cfg-'));
  const ruta = join(dir, 'glosomata.json');
  writeFileSync(ruta,
    typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
  return ruta;
}

// base verde SÓLO en darwin (say): para probar el gate del exit
const CONFIG_VERDE = {
  engines: {
    tts: [{ id: 'say', adapter: 'say', selected: true,
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 200 } }],
    stt: { whisper_bin: '/usr/bin/say', whisper_model: '/usr/bin/say' },
  },
  constraints: {},
};

// base rota EN CUALQUIER plataforma (kokoro → python_ausente): para
// aserciones de sección/causa sin depender de darwin
const CONFIG_TTS_ROTO = {
  engines: {
    tts: [{ id: 'kokoro-x', adapter: 'kokoro', selected: true,
      python: '/no/existe/python', model: '/no/existe/model',
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 300 } }],
    stt: {},
  },
};

function cli(args, rutaCfg, extra = {}) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8', cwd: CWD,
    env: { ...process.env, GLOSOMATA_CONFIG: rutaCfg, ...extra },
  });
}

function veredicto(args, rutaCfg, extra = {}) {
  try {
    return { code: 0, data: JSON.parse(cli(args, rutaCfg, extra)) };
  } catch (e) {
    return { code: e.status, data: JSON.parse(e.stdout) };
  }
}

function doctor(rutaCfg, extra = {}) {
  return veredicto(['doctor'], rutaCfg, extra);
}

// —— schema (P0.2): engines.diar y constraints con dientes ——

const configSchema = (diar, constraints) => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  if (diar !== undefined) cfg.engines.diar = diar;
  if (constraints !== undefined) cfg.constraints = constraints;
  return cfg;
};

test('schema: engines.diar completo valida', () => {
  const errores = validar(configSchema(DIAR_SANO), schema);
  assert.deepEqual(errores, []);
});

test('schema: diar sin pipeline → rechazo (las TRES rutas requeridas)', () => {
  const { pipeline, ...sinPipeline } = DIAR_SANO;
  assert.notEqual(
    validar(configSchema(sinPipeline), schema).length, 0);
});

test('schema: clave extra en diar → rechazo (cerrado)', () => {
  const conExtra = { ...DIAR_SANO, num_speakers: 2 };
  assert.notEqual(validar(configSchema(conExtra), schema).length, 0);
});

test('schema: constraints diar en rango validan; fuera, rechazo', () => {
  assert.deepEqual(
    validar(configSchema(undefined,
      { diar_max_duration_s: 14400, diar_max_wall_s: 7200 }), schema),
    []);
  for (const mala of [
    { diar_max_duration_s: 30 }, // bajo el mínimo 60
    { diar_max_duration_s: 90000 }, // sobre el tope 86400
    { diar_max_wall_s: 10 },
    { diar_max_wall_s: 100000 },
    { diar_max_duration_s: 'largo' }, // tipo
  ]) {
    assert.notEqual(
      validar(configSchema(undefined, mala), schema).length, 0,
      JSON.stringify(mala));
  }
});

// —— diagnosticoDiar: unidad pura (sin subprocess) ——

test('diagnosticoDiar: ausente → null (no declarado no es defecto)', async () => {
  assert.equal(await diagnosticoDiar(CONFIG_TTS_ROTO), null);
  assert.equal(await diagnosticoDiar({ engines: {} }), null);
});

test('diagnosticoDiar: forma basura → probe_fallido (fail-closed)', async () => {
  assert.deepEqual(await diagnosticoDiar({ engines: { diar: 42 } }),
    { ok: false, causa: 'probe_fallido' });
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: { python: '/x' } } }),
    { ok: false, causa: 'probe_fallido' });
});

test('diagnosticoDiar: orden de causas python → script → pesos', async () => {
  const con = (over) => ({ engines: { diar: { ...DIAR_SANO, ...over } } });
  assert.deepEqual(
    await diagnosticoDiar(con({ python: '/no/existe/python' })),
    { ok: false, causa: 'python_ausente' });
  assert.deepEqual(
    await diagnosticoDiar(con({ script: '/no/existe/s.py' })),
    { ok: false, causa: 'script_ausente' });
  assert.deepEqual(
    await diagnosticoDiar(con({ pipeline: '/no/existe/pipeline' })),
    { ok: false, causa: 'pesos_ausentes' });
});

test('diagnosticoDiar: pipeline archivo (no dir) o sin config.yaml → pesos_ausentes', async () => {
  const archivo = join(dirFix, 'no-dir.yaml');
  writeFileSync(archivo, '');
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: { ...DIAR_SANO,
      pipeline: archivo } } }),
    { ok: false, causa: 'pesos_ausentes' });
  const sinCfg = join(dirFix, 'pipeline-vacio');
  mkdirSync(sinCfg);
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: { ...DIAR_SANO,
      pipeline: sinCfg } } }),
    { ok: false, causa: 'pesos_ausentes' });
});

test('diagnosticoDiar: fixture sano → ok', async () => {
  assert.deepEqual(
    await diagnosticoDiar({ engines: { diar: DIAR_SANO } }),
    { ok: true });
});

// —— doctor: sección opcional con gate (contrato §7) ——

test('doctor: diar NO declarado → sin sección y exit intacto (regresión)', () => {
  const base = doctor(configTemporal(CONFIG_TTS_ROTO));
  const d = JSON.parse(JSON.stringify(base.data));
  assert.equal('diar' in d, false);
  assert.equal(base.code, 1); // por el motor roto, no por diar
});

test('doctor: diar declarado sano → sección ok, exit del veredicto base', () => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = DIAR_SANO;
  const r = doctor(configTemporal(cfg));
  assert.deepEqual(r.data.diar, { ok: true });
  // el exit lo decide el resto (motor roto → 1): diar sano no rescata
  assert.equal(r.code, 1);
});

test('doctor: diar declarado roto → causa exacta (independiente de SO)', () => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = { ...DIAR_SANO, pipeline: '/no/existe/pipeline' };
  const r = doctor(configTemporal(cfg));
  assert.deepEqual(r.data.diar, { ok: false, causa: 'pesos_ausentes' });
});

test('doctor: diar declarado-but-roto TUMBA el exit (gate, camino verde)', (t) => {
  if (process.platform !== 'darwin') {
    return t.skip('requiere darwin (say): base verde');
  }
  const verde = doctor(configTemporal(CONFIG_VERDE),
    { GLOSOMATA_FFMPEG: '/usr/bin/say' });
  assert.equal(verde.code, 0); // sin diar: matrices existentes intactas

  const roto = structuredClone(CONFIG_VERDE);
  roto.engines.diar = { ...DIAR_SANO, python: '/no/existe/python' };
  const r = doctor(configTemporal(roto), { GLOSOMATA_FFMPEG: '/usr/bin/say' });
  assert.equal(r.code, 1);
  assert.deepEqual(r.data.diar, { ok: false, causa: 'python_ausente' });

  const sano = structuredClone(CONFIG_VERDE);
  sano.engines.diar = DIAR_SANO;
  const r2 = doctor(configTemporal(sano),
    { GLOSOMATA_FFMPEG: '/usr/bin/say' });
  assert.equal(r2.code, 0); // declarado Y sano: sigue operativo
  assert.deepEqual(r2.data.diar, { ok: true });
});

// —— config validate / set: diar declarado debe pasar (regla set) ——

test('config validate: diar no declarado → veredicto.diar null', () => {
  const r = veredicto(['config', 'validate'], configTemporal(CONFIG_TTS_ROTO));
  assert.equal(r.data.diar, null);
});

test('config validate: diar sano → disponible aunque otro motor falle', () => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = DIAR_SANO;
  const r = veredicto(['config', 'validate'], configTemporal(cfg));
  assert.equal(r.code, 1); // kokoro roto decide el exit
  assert.deepEqual(r.data.diar,
    { declarado: true, available: true });
});

test('config validate: diar declarado roto → veredicto con causa', () => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = { ...DIAR_SANO, script: '/no/existe/s.py' };
  const r = veredicto(['config', 'validate'], configTemporal(cfg));
  assert.equal(r.code, 1);
  assert.deepEqual(r.data.diar,
    { declarado: true, available: false, causa: 'script_ausente' });
});

test('config set: candidato con diar roto → rechazado, original intacto', (t) => {
  if (process.platform !== 'darwin') {
    return t.skip('requiere darwin (say): candidato verde en lo demás');
  }
  const real = configTemporal(CONFIG_VERDE);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const cand = join(rt, 'cand.json');
  const mala = structuredClone(CONFIG_VERDE);
  mala.engines.diar = { ...DIAR_SANO, pipeline: '/no/existe/p' };
  writeFileSync(cand, JSON.stringify(mala));
  assert.throws(() => execFileSync('node',
    [CLI, 'config', 'set', cand], {
      encoding: 'utf8', cwd: CWD,
      env: { ...process.env, GLOSOMATA_CONFIG: real,
        GLOSOMATA_RUNTIME: rt },
    }),
  (e) => e.status === 1 && /config_write_failed/.test(e.stderr)
    && /pesos_ausentes/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], real)), CONFIG_VERDE);
});

test('config set válido con diar sano: escribe y reporta diar', (t) => {
  if (process.platform !== 'darwin') {
    return t.skip('requiere darwin (say): candidato verde');
  }
  const real = configTemporal(CONFIG_VERDE);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const cand = join(rt, 'cand.json');
  const buena = structuredClone(CONFIG_VERDE);
  buena.engines.diar = DIAR_SANO;
  writeFileSync(cand, JSON.stringify(buena));
  const out = JSON.parse(execFileSync('node',
    [CLI, 'config', 'set', cand], {
      encoding: 'utf8', cwd: CWD,
      env: { ...process.env, GLOSOMATA_CONFIG: real,
        GLOSOMATA_RUNTIME: rt },
    }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.diar, { declarado: true, available: true });
  assert.deepEqual(
    JSON.parse(cli(['config', 'list'], real)).engines.diar, DIAR_SANO);
});

after(() => rmSync(dirFix, { recursive: true, force: true }));

// —— D2: operación diarize (contrato §2-§5) ——

// exit≠1 con stdout JSON (errores diar_failed), o exit 2 usage
function salidaDiarize(argvCli, rutaCfg, extra = {}) {
  try {
    const out = cli(argvCli, rutaCfg, extra);
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? ''),
      err: String(e.stderr ?? '') };
  }
}

const CFG_DIAR = () => configTemporal(configDiarizable());

test('diarize: superficie estricta — cualquier desviación → usage', () => {
  const ruta = CFG_DIAR();
  for (const args of [[], ['--file'], ['--file', AUDIO_X, 'extra'],
    ['--file', '--otro'], ['--file', ''], ['-f', AUDIO_X],
    ['--audio', AUDIO_X]]) {
    const r = salidaDiarize(['diarize', ...args], ruta);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage/, JSON.stringify(args));
  }
});

test('diarize: sin engines.diar → not_supported (fail-closed)', () => {
  const r = salidaDiarize(['diarize', '--file', AUDIO_X],
    configTemporal(CONFIG_TTS_ROTO));
  assert.equal(r.code, 1);
  assert.match(r.err, /not_supported/);
});

test('diarize: declarado con python ausente → diar_failed/python_ausente', () => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = { ...DIAR_FALSO, python: '/no/existe/python' };
  const r = salidaDiarize(['diarize', '--file', AUDIO_X],
    configTemporal(cfg));
  assert.equal(r.code, 1);
  assert.match(r.err, /diar_failed/);
  assert.match(r.err, /python_ausente/);
});

test('diarize: ok → turnos canónicos, modo exclusive y duration_ms', () => {
  const rutaLog = join(dirFalso, 'log-ok.json');
  const r = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_LOG: rutaLog });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  // canónización: orden temporal + etiquetas por primera aparición
  assert.deepEqual(d.turns, [
    { speaker: 'SPEAKER_00', start_s: 0.2, end_s: 1 },
    { speaker: 'SPEAKER_01', start_s: 1.5, end_s: 2.5 },
    { speaker: 'SPEAKER_01', start_s: 3, end_s: 4 },
  ]);
  assert.equal(d.num_speakers, 2);
  assert.equal(d.mode, 'exclusive');
  assert.ok(Number.isInteger(d.duration_ms) && d.duration_ms >= 0);
  // H-1: el tope de duración viaja como 5º token del argv del script
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.deepEqual(log.argv, [fixScript, fixPipeline, AUDIO_X, '14400']);
});

test('diarize: entorno del subprocess FIJADO (telemetría OFF sin herencia)', () => {
  const rutaLog = join(dirFalso, 'log-env.json');
  // el padre prende la telemetría: glosomata debe forzar 0 igual
  const r = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_LOG: rutaLog,
      PYANNOTE_METRICS_ENABLED: '1', HF_HUB_OFFLINE: '0' });
  assert.equal(r.code, 0);
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.equal(log.PYANNOTE_METRICS_ENABLED, '0');
  assert.equal(log.HF_HUB_OFFLINE, '1');
});

test('diarize: constraint diar_max_duration_s viaja al script', () => {
  const rutaLog = join(dirFalso, 'log-dur.json');
  const r = salidaDiarize(['diarize', '--file', AUDIO_X],
    configTemporal(configDiarizable({ diar_max_duration_s: 300 })),
    { GLOSOMATA_DIAR_FAKE_LOG: rutaLog });
  assert.equal(r.code, 0);
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.equal(log.argv[3], '300');
});

test('diarize: exit 3 → audio_ilegible; exit 4 → audio_demasiado_largo', () => {
  const r3 = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_MODE: 'ilegible' });
  assert.equal(r3.code, 1);
  assert.match(r3.err, /diar_failed/);
  assert.match(r3.err, /audio_ilegible/);

  const r4 = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_MODE: 'largo' });
  assert.equal(r4.code, 1);
  assert.match(r4.err, /audio_demasiado_largo/);
});

test('diarize: resultados inválidos → inferencia_fallida (fail-closed)', () => {
  for (const modo of ['crash', 'basura', 'solape', 'plano']) {
    const r = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
      { GLOSOMATA_DIAR_FAKE_MODE: modo });
    assert.equal(r.code, 1, modo);
    assert.match(r.err, /diar_failed/, modo);
    assert.match(r.err, /inferencia_fallida/, modo);
  }
});

test('diarize: wall-clock evaluado → diar_failed/timeout_inferencia', () => {
  // valor 1 s (runtime lee el constraint tal cual; el piso 60 es de
  // schema, no del lector): el falso duerme 30 s y el muro gana
  const r = salidaDiarize(['diarize', '--file', AUDIO_X],
    configTemporal(configDiarizable({ diar_max_wall_s: 1 })),
    { GLOSOMATA_DIAR_FAKE_MODE: 'lento' });
  assert.equal(r.code, 1);
  assert.match(r.err, /diar_failed/);
  assert.match(r.err, /timeout_inferencia/);
});

// H-2 (issue #43): stop CROSS-PROCESS alcanza a diarize por el socket
// de esperadores, aunque no tome canal.lock. Runtime corto: sun_path.
test('diarize: stop de otro proceso → truncado por stdout, stderr vacío', async () => {
  const rt = `/tmp/glo-d2-${Math.random().toString(36).slice(2, 8)}`;
  const ruta = CFG_DIAR();
  const hijo = spawn('node', [CLI, 'diarize', '--file', AUDIO_X], {
    cwd: CWD, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GLOSOMATA_CONFIG: ruta,
      GLOSOMATA_RUNTIME: rt, GLOSOMATA_DIAR_FAKE_MODE: 'lento' },
  });
  let out = '';
  let err = '';
  hijo.stdout.on('data', (x) => { out += x; });
  hijo.stderr.on('data', (x) => { err += x; });
  const cerrar = new Promise((res) => hijo.on('close', res));

  // espera el registro del esperador (socket bajo espera/)
  const dirEspera = join(rt, `glosomata-${process.getuid()}`, 'espera');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (readdirSync(dirEspera).some((f) => f.endsWith('.sock'))) break;
    } catch {}
    await new Promise((res) => setTimeout(res, 50));
  }
  execFileSync('node', [CLI, 'stop'], {
    cwd: CWD,
    env: { ...process.env, GLOSOMATA_RUNTIME: rt },
  });
  const guardia = setTimeout(() => hijo.kill('SIGKILL'), 15_000);
  guardia.unref();
  const code = await cerrar;
  clearTimeout(guardia);
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.equal(d.turns, null);
  assert.equal(d.truncated, true);
  assert.ok(Number.isInteger(d.duration_ms));
  assert.equal(err, ''); // truncado: stdout, sin código en stderr
  rmSync(rt, { recursive: true, force: true });
}, 30_000);

// LOW-2 (issue #43): get_config queda pineado LIMPIO con matriz diar
test('get_config (configSaneada): matriz CON diar → sin exposición', () => {
  const ruta = CFG_DIAR();
  const modulo = new URL('../src/matriz.mjs', import.meta.url).href;
  const out = JSON.parse(execFileSync('node', ['--input-type=module',
    '-e', `const m = await import(${JSON.stringify(modulo)});`
      + 'console.log(JSON.stringify(await m.configSaneada()));'],
  { cwd: CWD, encoding: 'utf8',
    env: { ...process.env, GLOSOMATA_CONFIG: ruta } }));
  assert.deepEqual(Object.keys(out.engines), ['tts', 'stt']);
  assert.equal('diar' in out.engines, false);
  assert.ok(!JSON.stringify(out).includes('diar'));
  assert.ok(!Object.keys(out.constraints ?? {})
    .some((k) => k.startsWith('diar')));
});

after(() => rmSync(dirFalso, { recursive: true, force: true }));
