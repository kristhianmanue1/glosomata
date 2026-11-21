// D2+ de diarización: operación CLI de `diarize` con MOTOR FALSO
// (hermético: registra argv/env y emite conductas del contrato §4).
// D1 (probe/doctor/config/schema) vive en tests/diar.test.mjs.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync,
  readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'src/cli.mjs';
const CWD = new URL('..', import.meta.url).pathname;

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
// emitir drena ANTES de salir: exit() tras una escritura grande por
// tubería la trunca (mismo defecto que el de src/cli.mjs). El
// "device" emula el campo del script real (petición 2026-11-21).
const emitir = (o) => process.stdout.write(JSON.stringify(
  { device: process.env.GLOSOMATA_DIAR_FAKE_DEVICE ?? 'cpu', ...o }),
  () => process.exit(0));
const modos = {
  ok: () => emitir({ turns: [
    { speaker: 'voz_b', start_s: 1.5, end_s: 2.5 },
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
    { speaker: 'voz_b', start_s: 3, end_s: 4 },
  ] }),
  'ok-emb': () => emitir({ turns: [
    { speaker: 'voz_b', start_s: 1.5, end_s: 2.5 },
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
  ],
  embeddings: {
    voz_a: [0.11, 0.22, 0.33, 0.44],
    voz_b: [-0.11, -0.22, -0.33, -0.44],
  } }),
  'emb-sobra': () => emitir({ turns: [
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
  ],
  embeddings: {
    voz_a: [0.1, 0.2, 0.3, 0.4],
    voz_fantasma: [0.5, 0.6, 0.7, 0.8],
  } }),
  'emb-falta': () => emitir({ turns: [
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
    { speaker: 'voz_b', start_s: 1.5, end_s: 2.5 },
  ],
  embeddings: { voz_a: [0.1, 0.2, 0.3, 0.4] } }),
  'emb-malo': () => emitir({ turns: [
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
  ],
  embeddings: { voz_a: [0.1, 'no-numero', 0.3, 0.4] } }),
  'emb-dim': () => emitir({ turns: [
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
    { speaker: 'voz_b', start_s: 1.5, end_s: 2.5 },
  ],
  embeddings: {
    voz_a: [0.1, 0.2, 0.3, 0.4],
    voz_b: [0.5, 0.6, 0.7, 0.8, 0.9],
  } }),
  // H4 (r1): vector de puros ceros — padding del motor para hablantes
  // «extra»; norma 0 → coseno indefinido → se rechaza fail-closed
  'emb-cero': () => emitir({ turns: [
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
  ],
  embeddings: { voz_a: [0, 0, 0, 0] } }),
  'emb-silencio': () => emitir({ turns: [], embeddings: {} }),
  'dev-falta': () => process.stdout.write(
    JSON.stringify({ turns: [
      { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
    ] }), () => process.exit(0)),
  'dev-malo': () => emitir({ device: 'tpu', turns: [
    { speaker: 'voz_a', start_s: 0.2, end_s: 1.0 },
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
  subms: () => emitir({ turns: [
    { speaker: 'x', start_s: 1.0001, end_s: 1.0002 },
  ] }),
  gigante: () => {
    process.stdout.write('x'.repeat(17 * 1024 * 1024)); salir(0);
  },
  // regresión del stdout truncado (orden 2026-11-17): JSON VÁLIDO
  // > 1 MB por TUBERÍA — antes de drenar exit(), se cortaba a 64 KiB
  'gigante-json': () => {
    const turns = [];
    for (let i = 0; i < 20000; i++) {
      turns.push({ speaker: 'voz_a', start_s: i * 0.2,
        end_s: i * 0.2 + 0.1 });
    }
    emitir({ turns });
  },
  lento: () => setTimeout(() => emitir({ turns: [] }), 30000),
};
(modos[modo] ?? (() => salir(1)))();
`);
chmodSync(FALSO_PY, 0o755);

// stubs estructurales (el probe exige existencia; el falso no los lee)
const fixScript = join(dirFalso, 'stub-script.py');
const fixPipeline = join(dirFalso, 'stub-pipeline');
writeFileSync(fixScript, '');
mkdirSync(fixPipeline);
writeFileSync(join(fixPipeline, 'config.yaml'), '');

const DIAR_FALSO = { python: FALSO_PY, script: fixScript,
  pipeline: fixPipeline };
// variante SANA estructural (python = el falso, que existe): para
// doctor/validate donde el probe debe pasar
const DIAR_SANO = DIAR_FALSO;
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

after(() => rmSync(dirFalso, { recursive: true, force: true }));

// —— D2: operación diarize (contrato §2-§5) ——

// exit≠1 con stdout JSON (errores diar_failed), o exit 2 usage.
// H2 (r1): captura stderr SIEMPRE (también en éxito) — la garantía
// biométrica «ninguna huella en stderr» se aserta con los valores
// REALES del fixture.
function salidaDiarize(argvCli, rutaCfg, extra = {}) {
  const r = spawnSync('node', [CLI, ...argvCli], {
    encoding: 'utf8', cwd: CWD,
    env: { ...process.env, GLOSOMATA_CONFIG: rutaCfg, ...extra },
  });
  return { code: r.status, out: String(r.stdout ?? ''),
    err: String(r.stderr ?? '') };
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
  // H-1: el tope de duración viaja como 5º token del argv del script,
  // el modo de huellas como 6º (enmienda 2026-11-17: '0' sin flag) y
  // el dispositivo como 7º (petición 2026-11-21: default 'cpu')
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.deepEqual(log.argv,
    [fixScript, fixPipeline, AUDIO_X, '14400', '0', 'cpu']);
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

test('diarize: turno sub-milisegundo colapsa al redondear → fallo (H-2 r1)', () => {
  // crudo 1.0001→1.0002 valida como end>start pero redondea a 1,1
  const r = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_MODE: 'subms' });
  assert.equal(r.code, 1);
  assert.match(r.err, /inferencia_fallida/);
});

test('diarize: stdout sobre el tope 16 MiB → inferencia_fallida (H-3 r1)', () => {
  const r = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_MODE: 'gigante' });
  assert.equal(r.code, 1);
  assert.match(r.err, /diar_failed/);
  assert.match(r.err, /inferencia_fallida/);
});

// H1 (r1, BLOCKER): anclar la frontera Node↔script REAL — el script
// del repo con python3 DEL SISTEMA (stdlib sólo; los imports de
// pyannote viven DESPUÉS de estos guards): la forma exacta que
// diar.mjs construye debe pasar el guard de argv, y los exits
// tempranos (2/3) deben ser los contratados. Desde la petición
// 2026-11-21 la forma son SEIS tokens tras el intérprete (con el
// dispositivo).
test('script real: guard de argv y exits tempranos sin pyannote', () => {
  const script = new URL('../src/diar/diarize_pyannote.py',
    import.meta.url).pathname;
  const correr = (args, env) => spawnSync('python3',
    [script, ...args], { encoding: 'utf8', env: { ...process.env,
      ...env } });
  const ENV_OK = { PYANNOTE_METRICS_ENABLED: '0', HF_HUB_OFFLINE: '1' };

  // env sin las dos variables exigidas → exit 2 (rehúsa)
  const sinEnv = correr(
    ['/no/pipeline', '/no/audio.wav', '14400', '0', 'cpu'],
    { PYANNOTE_METRICS_ENABLED: undefined, HF_HUB_OFFLINE: undefined });
  assert.equal(sinEnv.status, 2);

  // forma EXACTA de diar.mjs (6 tokens tras el intérprete): el
  // guard acepta y el audio inexistente responde exit 3 ANTES de
  // importar
  const formaReal = correr(
    ['/no/pipeline', '/no/audio.wav', '14400', '0', 'cpu'], ENV_OK);
  assert.equal(formaReal.status, 3);

  // token extra o modo de huellas/dispositivo inválido → exit 2
  const extra = correr(
    ['/no/p', '/no/a.wav', '1', '0', 'cpu', 'extra'], ENV_OK);
  assert.equal(extra.status, 2);
  const modoMalo = correr(['/no/p', '/no/a.wav', '14400', '2', 'cpu'],
    ENV_OK);
  assert.equal(modoMalo.status, 2);
  const dispMalo = correr(
    ['/no/p', '/no/a.wav', '14400', '0', 'tpu'], ENV_OK);
  assert.equal(dispMalo.status, 2);
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

// —— Enmienda 2026-11-17 (huellas de voz opcionales) ——

test('diarize --embeddings: huellas por etiqueta canónica con dim y modelo', () => {
  const rutaLog = join(dirFalso, 'log-emb.json');
  const r = salidaDiarize(['diarize', '--file', AUDIO_X, '--embeddings'],
    CFG_DIAR(), { GLOSOMATA_DIAR_FAKE_LOG: rutaLog,
      GLOSOMATA_DIAR_FAKE_MODE: 'ok-emb' });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  // voz_a es primera EN EL TIEMPO → SPEAKER_00 (la cruda jamás sale)
  assert.deepEqual(Object.keys(d.speakers), ['SPEAKER_00', 'SPEAKER_01']);
  assert.deepEqual(d.speakers.SPEAKER_00,
    { embedding: [0.11, 0.22, 0.33, 0.44], dim: 4 });
  assert.deepEqual(d.speakers.SPEAKER_01,
    { embedding: [-0.11, -0.22, -0.33, -0.44], dim: 4 });
  assert.equal(d.embedding_model,
    'speaker-diarization-community-1#embedding');
  // el modo viaja como 6º token del argv del script
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.equal(log.argv[4], '1');
  // H2 (r1): garantía biométrica CON valores reales del fixture —
  // ni stderr del proceso NI el registro del falso llevan huella
  assert.ok(!r.err.includes('0.11') && !r.err.includes('0.44'),
    'huella en stderr');
  assert.ok(!JSON.stringify(log).includes('0.11'),
    'huella en el registro del motor falso');
});

test('diarize --embeddings: flag también admitido antes de --file', () => {
  const r = salidaDiarize(['diarize', '--embeddings', '--file', AUDIO_X],
    CFG_DIAR(), { GLOSOMATA_DIAR_FAKE_MODE: 'ok-emb' });
  assert.equal(r.code, 0);
  assert.ok(JSON.parse(r.out).speakers);
});

test('diarize SIN --embeddings: salida idéntica aunque el motor las traiga', () => {
  const rutaLog = join(dirFalso, 'log-noemb.json');
  const r = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_LOG: rutaLog,
      GLOSOMATA_DIAR_FAKE_MODE: 'ok-emb' });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.equal('speakers' in d, false);
  assert.equal('embedding_model' in d, false);
  // H5 (r1): pineo exacto de la forma — claves de siempre + device
  // (aditivo, petición 2026-11-21; sin --embeddings ni speakers)
  assert.deepEqual(Object.keys(d),
    ['turns', 'num_speakers', 'mode', 'device', 'duration_ms']);
  // modo '0' en el argv: el motor ni las calcula si no se las piden
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.equal(log.argv[4], '0');
});

test('diarize --embeddings: silencio → speakers {} válido', () => {
  const r = salidaDiarize(['diarize', '--file', AUDIO_X, '--embeddings'],
    CFG_DIAR(), { GLOSOMATA_DIAR_FAKE_MODE: 'emb-silencio' });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.deepEqual(d.speakers, {});
  assert.equal(d.num_speakers, 0);
});

test('diarize --embeddings: incoherencias del motor → inferencia_fallida', () => {
  // emb-cero: vector de puros ceros (padding del motor, H4 r1):
  // norma 0 → coseno indefinido → fail-closed, no huella basura.
  // Marcador de stderr por modo (H1 r2): un float PRESENTE en el
  // fixture de ese modo (emb-cero es todo ceros: indistinguible de
  // metadatos numéricos, se excluye del assert de contenido).
  const marcador = { 'emb-sobra': '0.8', 'emb-falta': '0.4',
    'emb-malo': '0.3', 'emb-dim': '0.9' };
  for (const modo of ['emb-sobra', 'emb-falta', 'emb-malo', 'emb-dim',
    'emb-cero']) {
    const r = salidaDiarize(['diarize', '--file', AUDIO_X, '--embeddings'],
      CFG_DIAR(), { GLOSOMATA_DIAR_FAKE_MODE: modo });
    assert.equal(r.code, 1, modo);
    assert.match(r.err, /diar_failed/, modo);
    assert.match(r.err, /inferencia_fallida/, modo);
    // y el fallo no filtra la huella por stderr (H1 r2: marcador real)
    if (marcador[modo] !== undefined) {
      assert.ok(!r.err.includes(marcador[modo]),
        `${modo}: huella en stderr`);
    }
  }
});

test('diarize --embeddings: superficie estricta — duplicado o mal puesto → usage', () => {
  const ruta = CFG_DIAR();
  for (const args of [
    ['--file', AUDIO_X, '--embeddings', '--embeddings'],
    ['--embeddings', '--embeddings', '--file', AUDIO_X],
    ['--file', AUDIO_X, '--embeddings', 'extra'],
    ['--embeddings'],
  ]) {
    const r = salidaDiarize(['diarize', ...args], ruta);
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /usage/, JSON.stringify(args));
  }
});

// Regresión del defecto CLI (orden 2026-11-17): process.exit() cortaba
// stdout en TUBERÍA a ~64 KiB antes del volcado asíncrono (visto por
// tequio con --embeddings sobre un tramo de 1800 s). Con el drenado
// (exitCode + salida natural), un JSON > 1 MB llega COMPLETO y válido
// por tubería, con el código de salida del contrato. Vehículo:
// diarize con falso python (el defecto era de la CLI entera).
test('CLI: JSON > 1 MB por tubería llega completo y válido', () => {
  const r = spawnSync('node', [CLI, 'diarize', '--file', AUDIO_X], {
    encoding: 'buffer', cwd: CWD, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GLOSOMATA_CONFIG: CFG_DIAR(),
      GLOSOMATA_DIAR_FAKE_MODE: 'gigante-json' },
  });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.length > 1024 * 1024,
    `stdout chico: ${r.stdout.length}`);
  const d = JSON.parse(r.stdout.toString('utf8'));
  assert.equal(d.turns.length, 20000);
  assert.equal(d.num_speakers, 1);
});

// —— Petición 2026-11-21: dispositivo de cómputo (cpu|cuda|mps) ——

test('diarize device: default cpu (argv 7º token) y campo en la salida', () => {
  const r = salidaDiarize(['diarize', '--file', AUDIO_X], CFG_DIAR(),
    { GLOSOMATA_DIAR_FAKE_MODE: 'ok' });
  assert.equal(r.code, 0);
  const d = JSON.parse(r.out);
  assert.equal(d.device, 'cpu');
});

test('diarize device: engines.diar.device viaja al script como 7º token', () => {
  const rutaLog = join(dirFalso, 'log-dev.json');
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = { ...DIAR_FALSO, device: 'mps' };
  const r = salidaDiarize(['diarize', '--file', AUDIO_X],
    configTemporal(cfg),
    { GLOSOMATA_DIAR_FAKE_LOG: rutaLog,
      GLOSOMATA_DIAR_FAKE_DEVICE: 'mps' });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).device, 'mps');
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.equal(log.argv[5], 'mps');
});

test('diarize device: valor fuera del enum en la matriz → cpu (guard de runtime)', () => {
  const rutaLog = join(dirFalso, 'log-dev-bad.json');
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = { ...DIAR_FALSO, device: 'tpu' };
  const r = salidaDiarize(['diarize', '--file', AUDIO_X],
    configTemporal(cfg), { GLOSOMATA_DIAR_FAKE_LOG: rutaLog });
  assert.equal(r.code, 0);
  const log = JSON.parse(readFileSync(rutaLog, 'utf8'));
  assert.equal(log.argv[5], 'cpu');
});

test('diarize device: salida sin device o con valor inválido → inferencia_fallida', () => {
  const cfg = structuredClone(CONFIG_TTS_ROTO);
  cfg.engines.diar = DIAR_FALSO;
  for (const modo of ['dev-falta', 'dev-malo']) {
    const r = salidaDiarize(['diarize', '--file', AUDIO_X],
      configTemporal(cfg), { GLOSOMATA_DIAR_FAKE_MODE: modo });
    assert.equal(r.code, 1, modo);
    assert.match(r.err, /inferencia_fallida/, modo);
  }
});


after(() => rmSync(dirFalso, { recursive: true, force: true }));

