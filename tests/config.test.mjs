// P1.1: config list / config get — lectura cruda de la matriz por
// CLI, con GLOSOMATA_CONFIG aislado. Sin mocks: el contrato es
// observable por proceso.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'src/cli.mjs';
const CWD = new URL('..', import.meta.url).pathname;

// set escribe: cada test aísla config Y runtime (backups) en su
// propio directorio efímero
function entorno(rutaCfg, runtimeDir) {
  return {
    ...process.env,
    GLOSOMATA_CONFIG: rutaCfg,
    ...(runtimeDir ? { GLOSOMATA_RUNTIME: runtimeDir } : {}),
  };
}

const CONFIG_VALIDA = {
  engines: {
    tts: [{ id: 'say', adapter: 'say', selected: true,
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 200 } }],
    stt: {},
  },
  constraints: { session_ttl_min: 15 },
};

// motor que falla probes EN CUALQUIER plataforma: kokoro revisa
// plataforma primero; en darwin sigue a python '/no/existe' →
// python_ausente. Determinista para CI linux y dev darwin.
const CONFIG_MOTOR_ROTO = {
  engines: {
    tts: [{ id: 'kokoro-x', adapter: 'kokoro', selected: true,
      python: '/no/existe/python', model: '/no/existe/model',
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 300 } }],
    stt: {},
  },
};

function configAislada(contenido) {
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-cfg-'));
  const ruta = join(dir, 'glosomata.json');
  writeFileSync(ruta, typeof contenido === 'string'
    ? contenido : JSON.stringify(contenido));
  return ruta;
}

function cli(args, rutaCfg) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    cwd: CWD,
    env: { ...process.env, GLOSOMATA_CONFIG: rutaCfg },
  });
}

test('config list: entrega el JSON crudo de disco', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const out = JSON.parse(cli(['config', 'list'], ruta));
  assert.deepEqual(out, CONFIG_VALIDA);
});

test('config list: crudo de verdad — sin campos derivados de probes', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const out = JSON.parse(cli(['config', 'list'], ruta));
  assert.equal('available' in out.engines.tts[0], false);
  assert.equal('causa' in out.engines.tts[0], false);
});

test('config list: config ilegible → config_unreadable', () => {
  const ruta = configAislada('{ esto no es json');
  assert.throws(() => cli(['config', 'list'], ruta),
    (e) => e.status === 1 && /config_unreadable/.test(e.stderr));
});

test('config get engines: subárbol completo', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const out = JSON.parse(cli(['config', 'get', 'engines'], ruta));
  assert.deepEqual(out, CONFIG_VALIDA.engines);
});

test('config get constraints: subárbol y ausencia declarada (null)', () => {
  const sinConstraints = { engines: CONFIG_VALIDA.engines };
  const ruta = configAislada(sinConstraints);
  const out = JSON.parse(cli(['config', 'get', 'constraints'], ruta));
  assert.equal(out, null);
});

test('config get: sección inventada o traversal → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  for (const mala of ['motores', 'engines.tts', 'engines.tts.0.id']) {
    assert.throws(() => cli(['config', 'get', mala], ruta),
      (e) => e.status === 2 && /usage/.test(e.stderr), mala);
  }
});

test('config get: sin sección → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config', 'get'], ruta),
    (e) => e.status === 2);
});

test('config: sin subcomando o desconocido → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config'], ruta), (e) => e.status === 2);
  assert.throws(() => cli(['config', 'edit'], ruta), (e) => e.status === 2);
});

test('config list: argumentos extra → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config', 'list', '--todo'], ruta),
    (e) => e.status === 2);
});

// —— config validate (P1.3): veredicto estilo doctor ——

// exit≠0 con veredicto por stdout: leer e.stdout del error
function veredicto(args, rutaCfg) {
  try {
    const out = cli(args, rutaCfg);
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    return { code: e.status, data: JSON.parse(e.stdout) };
  }
}

test('config validate: JSON ilegible → veredicto, no excepción', () => {
  const ruta = configAislada('{ no json');
  const r = veredicto(['config', 'validate'], ruta);
  assert.equal(r.code, 1);
  assert.ok(r.data.estructura.length > 0);
  assert.equal(r.data.motores, null);
});

test('config validate: violación de schema → estructura con detalle', () => {
  const mala = structuredClone(CONFIG_VALIDA);
  mala.engines.tts[0].rate = 1000; // rango 50–500 (P0.2)
  const ruta = configAislada(mala);
  const r = veredicto(['config', 'validate'], ruta);
  assert.equal(r.code, 1);
  assert.ok(r.data.estructura.some((x) => x.includes('rate')));
  assert.equal(r.data.motores, null);
});

test('config validate: estructura ok, motor roto → causa del probe', () => {
  const ruta = configAislada(CONFIG_MOTOR_ROTO);
  const r = veredicto(['config', 'validate'], ruta);
  assert.deepEqual(r.data.estructura, []);
  assert.equal(r.code, 1);
  assert.equal(r.data.motores.length, 1);
  assert.equal(r.data.motores[0].available, false);
  assert.ok(r.data.motores[0].causa);
});

test('config validate: stt no declarado no invalida (sólo no disponible)', () => {
  const ruta = configAislada(CONFIG_MOTOR_ROTO);
  const r = veredicto(['config', 'validate'], ruta);
  assert.equal(r.data.stt.declarado, false);
  assert.equal(r.data.stt.available, false);
});

test('config validate: todo declarado pasa → exit 0', async (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (say)');
  const ruta = configAislada(CONFIG_VALIDA);
  const out = cli(['config', 'validate'], ruta);
  const v = JSON.parse(out);
  assert.deepEqual(v.estructura, []);
  assert.equal(v.motores[0].available, true);
  assert.equal(v.stt.declarado, false);
});

test('config validate --file: juzga la candidata sin tocar la real', () => {
  const real = configAislada(CONFIG_VALIDA);
  const candidata = configAislada(CONFIG_MOTOR_ROTO);
  const r = veredicto(['config', 'validate', '--file', candidata], real);
  assert.equal(r.code, 1);
  assert.equal(r.data.motores[0].id, 'kokoro-x');
  // y la real sigue siendo la suya
  const lista = JSON.parse(cli(['config', 'list'], real));
  assert.deepEqual(lista, CONFIG_VALIDA);
});

test('config validate: --file sin valor o args extra → usage (exit 2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config', 'validate', '--file'], ruta),
    (e) => e.status === 2);
  assert.throws(() => cli(['config', 'validate', 'otra-cosa'], ruta),
    (e) => e.status === 2);
});

// —— config set (P1.2): replace atómico validado + backup ——

const { readFileSync, readdirSync, statSync,
  writeFileSync: write2 } = await import('node:fs');

test('config set: usage cerrado (sin archivo / flag / extra)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  assert.throws(() => cli(['config', 'set'], ruta), (e) => e.status === 2);
  assert.throws(() => cli(['config', 'set', '--file'], ruta),
    (e) => e.status === 2);
  assert.throws(() => cli(['config', 'set', 'a.json', 'b.json'], ruta),
    (e) => e.status === 2);
});

test('config set: candidato inexistente → config_write_failed, original intacto', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set',
    '/no/existe/cand.json'], { encoding: 'utf8', cwd: CWD,
    env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /config_write_failed/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], ruta)), CONFIG_VALIDA);
});

test('config set: candidato que viola schema → rechazado, original intacto', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const mala = structuredClone(CONFIG_VALIDA);
  mala.engines.tts[0].rate = 1000;
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(mala));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set', cand],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /config_write_failed/.test(e.stderr)
      && /rate/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], ruta)), CONFIG_VALIDA);
});

test('config set: motor sin kill_switch → rechazado (schema required)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const mala = structuredClone(CONFIG_VALIDA);
  delete mala.engines.tts[0].kill_switch;
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(mala));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set', cand],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /kill_switch/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], ruta)), CONFIG_VALIDA);
});

test('config set: ids duplicados → rechazado (semántica P1.2)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const dup = structuredClone(CONFIG_VALIDA);
  dup.engines.tts.push(structuredClone(dup.engines.tts[0]));
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(dup));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set', cand],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /duplicados/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], ruta)), CONFIG_VALIDA);
});

test('config set: selected cero o dos → rechazado (exactamente uno)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const cero = structuredClone(CONFIG_VALIDA);
  cero.engines.tts[0].selected = false;
  const cand0 = join(rt, 'cero.json');
  write2(cand0, JSON.stringify(cero));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set', cand0],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /selected/.test(e.stderr));

  const dos = structuredClone(CONFIG_VALIDA);
  dos.engines.tts.push({ ...structuredClone(dos.engines.tts[0]),
    id: 'otro-motor' });
  const cand2 = join(rt, 'dos.json');
  write2(cand2, JSON.stringify(dos));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set', cand2],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /selected/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], ruta)), CONFIG_VALIDA);
});

test('config set: candidato con campos derivados → rechazado (nunca se persisten)', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const sucia = structuredClone(CONFIG_VALIDA);
  sucia.engines.tts[0].available = true;
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(sucia));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set', cand],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /available/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], ruta)), CONFIG_VALIDA);
});

test('config set: motor declarado no disponible → rechazado con causa', () => {
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(CONFIG_MOTOR_ROTO));
  assert.throws(() => execFileSync('node', [CLI, 'config', 'set', cand],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }),
    (e) => e.status === 1 && /config_write_failed/.test(e.stderr)
      && /causa/.test(e.stderr));
  assert.deepEqual(JSON.parse(cli(['config', 'list'], ruta)), CONFIG_VALIDA);
});

test('config set válido: reemplaza, modo 0600 y sin derivados en disco', async (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (probes TTS)');
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const nueva = structuredClone(CONFIG_VALIDA);
  nueva.constraints = { session_ttl_min: 30 };
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(nueva));
  const out = JSON.parse(execFileSync('node', [CLI, 'config', 'set', cand],
    { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) }));
  assert.equal(out.ok, true);
  assert.ok(out.backup);
  const enDisco = JSON.parse(readFileSync(ruta, 'utf8'));
  assert.deepEqual(enDisco, nueva);
  assert.equal('available' in enDisco.engines.tts[0], false);
  assert.equal(statSync(ruta).mode & 0o777, 0o600);
});

test('config set: backup creado y podado a las últimas 5', async (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (probes TTS)');
  const ruta = configAislada(CONFIG_VALIDA);
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(CONFIG_VALIDA));
  for (let i = 0; i < 7; i++) {
    execFileSync('node', [CLI, 'config', 'set', cand],
      { encoding: 'utf8', cwd: CWD, env: entorno(ruta, rt) });
  }
  const backups = readdirSync(join(rt, `glosomata-${process.getuid()}`,
    'backups')).filter((f) => f.endsWith('.json'));
  assert.equal(backups.length, 5);
});

test('config set: destino inexistente → lo crea sin backup', async (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (probes TTS)');
  const rt = mkdtempSync(join(tmpdir(), 'glo-rt-'));
  const dirDestino = mkdtempSync(join(tmpdir(), 'glo-dest-'));
  const destino = join(dirDestino, 'glosomata.json');
  const cand = join(rt, 'cand.json');
  write2(cand, JSON.stringify(CONFIG_VALIDA));
  const out = JSON.parse(execFileSync('node', [CLI, 'config', 'set', cand],
    { encoding: 'utf8', cwd: CWD,
      env: { ...process.env, GLOSOMATA_CONFIG: destino,
        GLOSOMATA_RUNTIME: rt } }));
  assert.equal(out.ok, true);
  assert.equal(out.backup, undefined);
  assert.deepEqual(JSON.parse(readFileSync(destino, 'utf8')), CONFIG_VALIDA);
});
