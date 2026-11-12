// D1 de diarización (ADR-012): schema engines.diar + constraints,
// probe estructural diagnosticoDiar, wiring de doctor y de
// config validate/set. Expectaciones leídas del contrato
// docs/specs/contrato-diarizacion-v1.md (§3.1/§6/§7), no del código.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
