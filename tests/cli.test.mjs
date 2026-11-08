import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync,
  readdirSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'src/cli.mjs';
const RAIZ = new URL('..', import.meta.url).pathname;

function cli(args) {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf8',
    cwd: new URL('..', import.meta.url).pathname,
  });
}

test('CLI: ayuda sin comandos', () => {
  const out = cli([]);
  assert.match(out, /uso: glosomata/);
});

test('CLI: comando desconocido → exit 2', () => {
  assert.throws(() => cli(['nada']), (e) => e.status === 2);
});

test('CLI: templates --list entrega catálogo sin turns', () => {
  const out = JSON.parse(cli(['templates', '--list']));
  assert.ok(Array.isArray(out));
  assert.ok(out.some((t) => t.id === 'confirmar'));
  assert.ok(out.every((t) => t.turns === undefined));
});

test('CLI: templates --show con id válido', () => {
  const t = JSON.parse(cli(['templates', '--show', 'confirmar']));
  assert.equal(t.kind, 'structured');
});

test('CLI: templates --show traversal → template_invalid', () => {
  assert.throws(() => cli(['templates', '--show', '../etc/passwd']),
    (e) => /template_invalid/.test(e.stderr));
});

test('CLI: session new sin plantilla emite sesión v1', () => {
  const ses = JSON.parse(cli(['session', 'new']));
  assert.equal(ses.schema, 'glosomata/sesion-v1');
});

test('CLI: session new --template confirmar incrusta plantilla', () => {
  const ses = JSON.parse(cli(['session', 'new', '--template', 'confirmar']));
  assert.equal(ses.template.id, 'confirmar');
});

test('CLI: session new sin template → validate ok (SPEC-2, C1.5)', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const ses = JSON.parse(cli(['session', 'new']));
  assert.equal(ses.template, null);
  const ruta = join(mkdtempSync(join(tmpdir(), 'glosomata-test-')), 's.json');
  writeFileSync(ruta, JSON.stringify(ses));
  assert.equal(execFileSyncStatus(['validate', '--session', ruta, '--text', 'lo que sea']), 0);
});

test('CLI: validate JSON null / sin schema → session_invalid, sin TypeError (C1.3)', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-test-'));
  const nula = join(dir, 'null.json');
  writeFileSync(nula, 'null');
  // null.json antes explotaba con TypeError crudo fuera de la taxonomía
  assert.throws(
    () => execFileSync('node', [CLI, 'validate', '--session', nula, '--text', 'x'], {
      cwd: new URL('..', import.meta.url).pathname,
    }),
    (e) => e.status === 1 && /session_invalid/.test(e.stderr)
      && !/TypeError/.test(e.stderr));
  const ses = JSON.parse(cli(['session', 'new', '--template', 'confirmar']));
  delete ses.schema;
  const sinSchema = join(dir, 'sin-schema.json');
  writeFileSync(sinSchema, JSON.stringify(ses));
  assert.throws(
    () => execFileSync('node', [CLI, 'validate', '--session', sinSchema, '--text', 'sí'], {
      cwd: new URL('..', import.meta.url).pathname,
    }),
    (e) => e.status === 1 && /session_invalid/.test(e.stderr));
});

test('CLI: session new con session_ttl_min malformado → config_unreadable (C1.3)', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const ruta = join(mkdtempSync(join(tmpdir(), 'glosomata-test-')), 'g.json');
  // string numérico: antes la coerción acuñaba sesiones muertas al nacer
  writeFileSync(ruta, JSON.stringify({
    engines: { tts: [], stt: {} },
    constraints: { session_ttl_min: '30' },
  }));
  assert.throws(
    () => execFileSync('node', [CLI, 'session', 'new'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, GLOSOMATA_CONFIG: ruta },
    }),
    (e) => e.status === 1 && /config_unreadable/.test(e.stderr));
});

test('CLI: validate ok exit 0 / fail exit 1', () => {
  const { writeFileSync, mkdtempSync } = require('node:fs');
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-test-'));
  const ses = JSON.parse(cli(['session', 'new', '--template', 'confirmar']));
  const ruta = join(dir, 'ses.json');
  writeFileSync(ruta, JSON.stringify(ses));
  assert.equal(execFileSyncStatus(['validate', '--session', ruta, '--text', 'sí']), 0);
  assert.equal(execFileSyncStatus(['validate', '--session', ruta, '--text', 'nse']), 1);
});

function execFileSyncStatus(args) {
  try {
    execFileSync('node', [CLI, ...args], {
      cwd: new URL('..', import.meta.url).pathname,
    });
    return 0;
  } catch (e) {
    return e.status;
  }
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('CLI: version refleja package.json (fuente única, C0.1)', () => {
  const pkg = JSON.parse(
    require('node:fs').readFileSync(
      new URL('../package.json', import.meta.url), 'utf8'));
  const out = JSON.parse(cli(['version']));
  assert.equal(out.name, pkg.name);
  assert.equal(out.version, pkg.version);
});

// —— speak --text-stdin (mandato timbre-stdin 2026-11-08; corrección r2) ——

import { PassThrough } from 'node:stream';
import { leerStdin } from '../src/ops.mjs';
import { canonizar } from '../src/plantillas.mjs';
import { pedirStop, resetStop, stopGeneration } from '../src/canal.mjs';

// Motor de prueba (patrón de fixtures del repo): adaptador piper con bin
// falso que recibe el texto por SU stdin (ADR-005), vuelca {texto, argv}
// a un marcador y emite PCM de ceros. SIN DISPOSITIVO: el preload
// intercepta child_process.spawn SOLO para '/usr/bin/afplay' (vía del
// capitán, r2) con un hijo falso que emite close(0) y deja marcador —
// played:true proviene del flujo REAL (síntesis → WAV → pierna de
// playback) sin ejecutar afplay jamás. El silencio digital también era
// reproducción real (hallazgo 2 de la revisión): eliminado.
const dirSpeak = mkdtempSync(join(tmpdir(), 'glosomata-cli-speak-'));
const binEco = join(dirSpeak, 'eco');
const binFalla = join(dirSpeak, 'eco-falla');
const modeloEco = join(dirSpeak, 'modelo.onnx');
const cfgEco = join(dirSpeak, 'glosomata.json');
const marcadorEco = join(dirSpeak, 'recibido.json');
const marcadorFalla = join(dirSpeak, 'falla.json');
const marcadorAfplay = join(dirSpeak, 'afplay-interceptado.json');
const preload = join(dirSpeak, 'intercepta-afplay.mjs');
writeFileSync(modeloEco, '');
writeFileSync(binEco, `#!/usr/bin/env node
// motor de prueba: texto por stdin -> marcador {texto, argv}; PCM ceros.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { writeFileSync } = await import('node:fs');
writeFileSync(process.env.MARCADOR_ECO, JSON.stringify({
  texto: Buffer.concat(chunks).toString('utf8'),
  argv: process.argv.slice(2),
}));
process.stdout.write(Buffer.alloc(4410));
`);
writeFileSync(binFalla, `#!/usr/bin/env node
// motor que falla: deja constancia del texto recibido y muere con 3.
const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const { writeFileSync } = await import('node:fs');
writeFileSync(process.env.MARCADOR_FALLA, JSON.stringify({
  texto: Buffer.concat(chunks).toString('utf8'),
}));
process.exit(3);
`);
chmodSync(binEco, 0o700);
chmodSync(binFalla, 0o700);
// Preload (tmp): parchea child_process.spawn (CJS) y llama
// syncBuiltinESMExports para que el import ESM de canal.mjs vea el
// parche (verificado con sonda antes de adoptarlo). Fail-closed: si el
// parche no aplica, el preload lanza ANTES de ejecutar el CLI — nunca
// cae de vuelta a un afplay real.
writeFileSync(preload, `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const spawnReal = cp.spawn;
if (typeof spawnReal !== 'function') throw new Error('preload: sin spawn');
cp.spawn = (cmd, args, opts) => {
  if (cmd === '/usr/bin/afplay') {
    appendFileSync(process.env.MARCADOR_AFPLAY, JSON.stringify({ cmd, args }) + '\\n', { mode: 0o600 });
    const hijo = new EventEmitter();
    hijo.pid = 0;
    hijo.kill = () => true;
    hijo.stdin = new EventEmitter();
    hijo.stdout = new EventEmitter();
    hijo.stderr = new EventEmitter();
    process.nextTick(() => hijo.emit('close', 0));
    return hijo;
  }
  return spawnReal(cmd, args, opts);
};
syncBuiltinESMExports();
`);
writeFileSync(cfgEco, JSON.stringify({
  engines: {
    tts: [
      { id: 'eco', adapter: 'piper', bin: binEco, model: modeloEco,
        selected: true, kill_switch: { type: 'subprocess_kill',
          target: 'process_group', max_latency_ms: 500 } },
      { id: 'eco-falla', adapter: 'piper', bin: binFalla, model: modeloEco,
        kill_switch: { type: 'subprocess_kill',
          target: 'process_group', max_latency_ms: 500 } },
    ],
    stt: {},
  },
}));
// Matriz SIN motor (r3, B2): tts vacío — cargarMatriz la acepta; toda
// resolución de motor falla. Runtime aparte para no cruzar esperas.
const cfgSinMotor = join(dirSpeak, 'glosomata-sin-motor.json');
writeFileSync(cfgSinMotor, JSON.stringify({
  engines: { tts: [], stt: {} },
}));
// Runtimes cortos raíz del TMPDIR: el registro de espera es un
// socket Unix y sun_path cabe ~104 bytes en darwin (r4, H-5).
const rtEco = mkdtempSync(join(tmpdir(), 'gsw-'));
const rtSin = mkdtempSync(join(tmpdir(), 'gsw-'));
after(() => {
  rmSync(dirSpeak, { recursive: true, force: true });
  rmSync(rtEco, { recursive: true, force: true });
  rmSync(rtSin, { recursive: true, force: true });
});

function envEco() {
  return { ...process.env,
    GLOSOMATA_CONFIG: cfgEco,
    GLOSOMATA_RUNTIME: rtEco,
    MARCADOR_ECO: marcadorEco,
    MARCADOR_FALLA: marcadorFalla,
    MARCADOR_AFPLAY: marcadorAfplay };
}

function envSinMotor() {
  return { ...process.env,
    GLOSOMATA_CONFIG: cfgSinMotor,
    GLOSOMATA_RUNTIME: rtSin,
    MARCADOR_ECO: marcadorEco,
    MARCADOR_FALLA: marcadorFalla,
    MARCADOR_AFPLAY: marcadorAfplay };
}

// Directorio de espera del runtime aislado (registro r3, B1)
function dirEsperaDe(env) {
  return join(env.GLOSOMATA_RUNTIME,
    `glosomata-${process.getuid()}`, 'espera');
}

// Espera a que el hijo registre su pid como esperador (sin esto, un stop
// inmediato podría llegar antes del registro y la prueba sería flaky)
function esperarRegistro(env, ms = 8000) {
  const dir = dirEsperaDe(env);
  return new Promise((res, rej) => {
    const inicio = Date.now();
    const sondeo = setInterval(() => {
      let hay = false;
      try {
        hay = readdirSync(dir).some((f) => f.endsWith('.sock'));
      } catch {}
      if (hay) {
        clearInterval(sondeo);
        res(dir);
      } else if (Date.now() - inicio > ms) {
        clearInterval(sondeo);
        rej(new Error('el hijo no registró su espera'));
      }
    }, 25);
    sondeo.unref();
  });
}

// TODO hijo del CLI corre con el preload: aunque un test falle por una
// regresión, ningún camino puede ejecutar afplay real.
function speakCli(args, input = '') {
  return spawnSync('node', ['--import', preload, CLI, 'speak', ...args], {
    encoding: 'utf8', input, cwd: RAIZ, env: envEco() });
}

function limpiarMarcadores() {
  rmSync(marcadorEco, { force: true });
  rmSync(marcadorFalla, { force: true });
  rmSync(marcadorAfplay, { force: true });
}

// skip correcto: return tras t.skip (hallazgo 2 de la revisión: sin
// return, el cuerpo seguía ejecutándose en otras plataformas)
function requerirDarwin(t) {
  if (process.platform === 'darwin') return false;
  t.skip('piper reproduce con afplay (darwin)');
  return true;
}

test('CLI: speak --text-stdin reproduce (played:true) sin tocar el dispositivo', (t) => {
  if (requerirDarwin(t)) return;
  limpiarMarcadores();
  const texto = 'SECRETO-stdin con acentos áéíóú y ñ';
  const r = speakCli(['--engine', 'eco', '--text-stdin'], texto);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.played, true);
  assert.equal(out.engine, 'eco');
  assert.equal(out.echo, texto);
  assert.equal(out.truncated, false);
  const recibido = JSON.parse(readFileSync(marcadorEco, 'utf8'));
  // el texto llegó íntegro al motor por SU stdin
  assert.equal(recibido.texto, texto);
  // y ningún argv del motor contiene la locución
  assert.ok(!recibido.argv.some((a) => a.includes('SECRETO')));
  assert.ok(recibido.argv.includes('/dev/stdin'));
  // la pierna de playback se ejerció POR INTERCEPCIÓN (contador: 1
  // llamada, cmd afplay, arg = el WAV) — jamás un afplay real
  const intercepciones = readFileSync(marcadorAfplay, 'utf8')
    .trim().split('\n');
  assert.equal(intercepciones.length, 1);
  const inter = JSON.parse(intercepciones[0]);
  assert.equal(inter.cmd, '/usr/bin/afplay');
  assert.ok(inter.args[0].endsWith('.wav'));
});

test('CLI: speak --text (v1) sigue funcionando igual', (t) => {
  if (requerirDarwin(t)) return;
  limpiarMarcadores();
  const r = speakCli(['--engine', 'eco', '--text', 'texto plano por argv']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.played, true);
  assert.equal(JSON.parse(readFileSync(marcadorEco, 'utf8')).texto,
    'texto plano por argv');
  assert.equal(
    readFileSync(marcadorAfplay, 'utf8').trim().split('\n').length, 1);
});

test('CLI: motor que falla → tts_failed; el texto llegó y NO hubo playback', (t) => {
  if (requerirDarwin(t)) return;
  limpiarMarcadores();
  const r = speakCli(['--engine', 'eco-falla', '--text-stdin'],
    'texto que el motor rechaza');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tts_failed/);
  assert.equal(JSON.parse(readFileSync(marcadorFalla, 'utf8')).texto,
    'texto que el motor rechaza');
  // la síntesis murió ANTES del playback: afplay jamás se invocó
  assert.equal(existsSync(marcadorAfplay), false);
});

test('CLI: parser — --text-stdin y --text juntos → usage (ambos órdenes)', () => {
  for (const args of [['--text-stdin', '--text', 'hola'],
    ['--text', 'hola', '--text-stdin']]) {
    const r = speakCli(args, 'por stdin');
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.match(r.stderr, /usage/);
  }
});

test('CLI: parser — --text-stdin duplicada → usage', () => {
  const r = speakCli(['--text-stdin', '--text-stdin'], 'hola');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('CLI: parser — --text-stdin como valor de --engine → usage', () => {
  const r = speakCli(['--engine', '--text-stdin'], 'hola');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('CLI: speak --text-stdin con stdin vacío → usage (exit 2)', () => {
  const r = speakCli(['--engine', 'eco', '--text-stdin'], '');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('CLI: speak --text-stdin con 2001 caracteres → text_too_long', (t) => {
  // H-1 (r3): fuera de darwin no hay motor; la precedencia
  // portátil la fija la matriz sin motor, abajo.
  if (requerirDarwin(t)) return;
  const r = speakCli(['--engine', 'eco', '--text-stdin'], 'a'.repeat(2001));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /text_too_long/);
});

// Equivalencia de superficies en los contraejemplos de canonización
// (contraejemplo r2bis del capitán): --text y --text-stdin deciden IGUAL
// porque la cota streaming mide con la métrica de canonizar. Con motor
// disponible ambos aceptan (exit 0/played) o rechazan con el mismo
// código. En Linux este test se salta: el motor eco no está disponible y
// el orden de chequeos difiere por diseño (la cota precede al motor).
test('CLI: --text vs --text-stdin deciden igual (contraejemplos NFC/ZWSP)', (t) => {
  if (requerirDarwin(t)) return;
  limpiarMarcadores();
  const casos = [
    ['1000 pares a+acento (2000 crudos → 1000)', 'a\u0301'.repeat(1000)],
    ['1001 pares a+acento (2002 crudos → 2001)', 'a\u0301'.repeat(1001)],
    ['2001 crudos con ZWSP (→ 2000)', 'x'.repeat(2000) + '\u200B'],
    // r4, H-2: sólo-inaudibles — crudo NO vacío: habla '' como --text.
    ['sólo inaudibles (crudo no vacío → canonizado vacío)',
      '\u200B\u200B\u200C\uFEFF'],
  ];
  for (const [nombre, texto] of casos) {
    const porArgv = speakCli(['--engine', 'eco', '--text', texto]);
    const porStdin = speakCli(['--engine', 'eco', '--text-stdin'], texto);
    assert.equal(porStdin.status, porArgv.status,
      `${nombre}: stdin=${porStdin.status} argv=${porArgv.status}`);
    const codigo = (r) => r.stderr.match(/^glosomata: (\S+)/)?.[1] ?? '';
    assert.equal(codigo(porStdin), codigo(porArgv), nombre);
    if (porArgv.status === 0) {
      assert.equal(JSON.parse(porStdin.stdout).echo,
        JSON.parse(porArgv.stdout).echo, nombre);
    }
  }
  // el último caso habló el vacío canonizado: al motor llegó '' (r4, H-2)
  assert.equal(JSON.parse(readFileSync(marcadorEco, 'utf8')).texto, '');
});

test('CLI: stdin que excede el tope con el pipe ABIERTO responde sin EOF', async (t) => {
  // H-1 (r3): sin motor no hay rechazo temprano (drenaje): rama
  // portátil en el test de matriz sin motor.
  if (requerirDarwin(t)) return;
  limpiarMarcadores();
  const child = spawn('node',
    ['--import', preload, CLI, 'speak', '--engine', 'eco', '--text-stdin'],
    { stdio: ['pipe', 'pipe', 'pipe'], cwd: RAIZ, env: envEco() });
  child.stdin.on('error', () => {}); // EPIPE si el hijo muere antes
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const cierre = new Promise((res) => child.on('close', (code) => res(code)));
  child.stdin.write('a'.repeat(2100)); // sin end(): el pipe queda abierto
  const guardia = setTimeout(() => child.kill('SIGKILL'), 8000);
  guardia.unref();
  const code = await Promise.race([
    cierre,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('sin respuesta con el pipe abierto')), 8000)
      .unref()),
  ]);
  clearTimeout(guardia);
  assert.equal(code, 1, err);
  assert.match(err, /text_too_long/);
  assert.equal(existsSync(marcadorEco), false); // jamás llegó al motor
  child.stdin.destroy();
});

test('CLI: stop (SIGINT) durante la espera de stdin aborta sin hablar', async () => {
  limpiarMarcadores();
  const child = spawn('node',
    ['--import', preload, CLI, 'speak', '--engine', 'eco', '--text-stdin'],
    { stdio: ['pipe', 'pipe', 'pipe'], cwd: RAIZ, env: envEco() });
  child.stdin.on('error', () => {});
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const cierre = new Promise((res) => child.on('close', (code) => res(code)));
  // pipe abierto en silencio: nada llega por stdin
  await new Promise((res) => setTimeout(res, 400));
  child.kill('SIGINT');
  const code = await Promise.race([
    cierre,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('sin respuesta al stop')), 8000).unref()),
  ]);
  assert.equal(code, 1, out);
  const salida = JSON.parse(out);
  assert.equal(salida.played, false);
  assert.equal(salida.echo, null);
  assert.equal(salida.truncated, true);
  // abortó ANTES del motor y del reproductor
  assert.equal(existsSync(marcadorEco), false);
  assert.equal(existsSync(marcadorAfplay), false);
  child.stdin.destroy();
});

// r3 B1 / r4 H-5 — control positivo: stop de OTRO proceso, pipe
// ABIERTO y sin EOF: senal_remota:true (orden acusada por el
// socket del esperador) y la espera truncada.
test('CLI: stop de otro proceso trunca la espera de stdin (pipe abierto, senal_remota:true)', async () => {
  limpiarMarcadores();
  const child = spawn('node',
    ['--import', preload, CLI, 'speak', '--engine', 'eco', '--text-stdin'],
    { stdio: ['pipe', 'pipe', 'pipe'], cwd: RAIZ, env: envEco() });
  child.stdin.on('error', () => {});
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const cierre = new Promise((res) => child.on('close', (code) => res(code)));
  // pipe abierto en silencio (nada por stdin, jamás end())
  const dirEspera = await esperarRegistro(envEco());
  // stop desde OTRO proceso, mismo runtime aislado
  const stop = spawnSync('node', [CLI, 'stop'],
    { encoding: 'utf8', cwd: RAIZ, env: envEco() });
  assert.equal(stop.status, 0, stop.stderr);
  const senal = JSON.parse(stop.stdout);
  assert.equal(senal.stopped, true);
  assert.equal(senal.senal_remota, true); // control positivo B1
  const code = await Promise.race([
    cierre,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('sin respuesta al stop remoto')), 8000)
      .unref()),
  ]);
  assert.equal(code, 1, out);
  const salida = JSON.parse(out);
  assert.equal(salida.played, false);
  assert.equal(salida.echo, null);
  assert.equal(salida.truncated, true);
  // truncado ANTES del motor y del reproductor, y antes de todo EOF
  assert.equal(existsSync(marcadorEco), false);
  assert.equal(existsSync(marcadorAfplay), false);
  // el registro de espera no quedó huérfano
  assert.deepEqual(readdirSync(dirEspera), []);
  child.stdin.destroy();
});

// r3 B1 / r4 H-5 — huérfano (socket sin receptor: conectar falla):
// se barre en el siguiente stop, sin senal_remota.
test('CLI: stop barre el registro huérfano de un esperador muerto', async () => {
  const env = envEco();
  const dir = dirEsperaDe(env);
  mkdirSync(dir, { recursive: true });
  const huerfano = join(dir, 'huerfano.sock');
  writeFileSync(huerfano, 'muerto');
  const stop = spawnSync('node', [CLI, 'stop'],
    { encoding: 'utf8', cwd: RAIZ, env });
  assert.equal(stop.status, 0, stop.stderr);
  const senal = JSON.parse(stop.stdout);
  assert.equal(senal.stopped, true);
  assert.equal(senal.senal_remota, false); // nadie vivo que acuse
  assert.equal(existsSync(huerfano), false); // barrido
});

// r4, H-5 — contraejemplo del pid reciclado: huérfano cuyo nombre
// lleva el pid de un VIVO ajeno (ESTE runner); con señales por pid
// el stop lo habría matado — que este test siga ES la aserción.
test('CLI: registro huérfano con pid VIVO ajeno — stop jamás lo señala', async () => {
  const env = envSinMotor();
  const dir = dirEsperaDe(env);
  mkdirSync(dir, { recursive: true });
  const vivoAjeno = join(dir, `${process.pid}.sock`);
  writeFileSync(vivoAjeno, `${process.pid}`);
  const stop = spawnSync('node', [CLI, 'stop'],
    { encoding: 'utf8', cwd: RAIZ, env });
  assert.equal(stop.status, 0, stop.stderr);
  const senal = JSON.parse(stop.stdout);
  assert.equal(senal.senal_remota, false); // sin receptor: nadie acusó
  assert.equal(existsSync(vivoAjeno), false); // barrido como huérfano
});

// r3, B2 — precedencia comparativa con matriz SIN motor: mismas
// validaciones que --text significa el MISMO código por superficie.
test('CLI: matriz sin motor — mismas decisiones en ambas superficies (2001, vacío, inaudibles)', () => {
  limpiarMarcadores();
  const largo = 'a'.repeat(2001);
  const porArgv = spawnSync('node',
    ['--import', preload, CLI, 'speak', '--text', largo],
    { encoding: 'utf8', cwd: RAIZ, env: envSinMotor() });
  assert.equal(porArgv.status, 1, porArgv.stderr);
  assert.match(porArgv.stderr, /engine_unavailable/);
  assert.ok(!/text_too_long/.test(porArgv.stderr));
  const porStdin = spawnSync('node',
    ['--import', preload, CLI, 'speak', '--engine', 'eco', '--text-stdin'],
    { encoding: 'utf8', input: largo, cwd: RAIZ, env: envSinMotor() });
  assert.equal(porStdin.status, 1, porStdin.stderr);
  assert.match(porStdin.stderr, /engine_unavailable/);
  assert.ok(!/text_too_long/.test(porStdin.stderr));
  // mismo código, misma precedencia en el vacío: sin motor, stdin vacío
  // sigue siendo usage (como --text '')
  const vacioStdin = spawnSync('node',
    ['--import', preload, CLI, 'speak', '--text-stdin'],
    { encoding: 'utf8', input: '', cwd: RAIZ, env: envSinMotor() });
  assert.equal(vacioStdin.status, 2);
  assert.match(vacioStdin.stderr, /usage/);
  const vacioArgv = spawnSync('node',
    ['--import', preload, CLI, 'speak', '--text', ''],
    { encoding: 'utf8', cwd: RAIZ, env: envSinMotor() });
  assert.equal(vacioArgv.status, 2);
  assert.match(vacioArgv.stderr, /usage/);
  // jamás se acercó a un motor ni a un reproductor
  assert.equal(existsSync(marcadorEco), false);
  assert.equal(existsSync(marcadorAfplay), false);
  // r4, H-2 — portátil: sólo-inaudibles; crudo no vacío → mismo código
  // que --text '<inaudibles>' sin motor (el vacío se decide por crudo)
  const solo = '\u200B\u200C';
  const ina = spawnSync('node',
    ['--import', preload, CLI, 'speak', '--text', solo],
    { encoding: 'utf8', cwd: RAIZ, env: envSinMotor() });
  const ins = spawnSync('node',
    ['--import', preload, CLI, 'speak', '--engine', 'eco', '--text-stdin'],
    { encoding: 'utf8', input: solo, cwd: RAIZ, env: envSinMotor() });
  assert.equal(ina.status, 1, ina.stderr);
  assert.match(ina.stderr, /engine_unavailable/);
  assert.equal(ins.status, 1, ins.stderr);
  assert.match(ins.stderr, /engine_unavailable/);
  assert.ok(!/usage/.test(ins.stderr), ins.stderr);
});

// r3, B2 — sin motor, la lectura con pipe abierto NO responde
// text_too_long antes de EOF (drenaje): espera, y el stop la trunca.
test('CLI: sin motor y pipe abierto — sin rechazo temprano; stop trunca', async () => {
  limpiarMarcadores();
  const env = envSinMotor();
  const child = spawn('node',
    ['--import', preload, CLI, 'speak', '--engine', 'eco', '--text-stdin'],
    { stdio: ['pipe', 'pipe', 'pipe'], cwd: RAIZ, env });
  child.stdin.on('error', () => {});
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const cierre = new Promise((res) => child.on('close', (code) => res(code)));
  await esperarRegistro(env); // ya está leyendo (drenando)
  child.stdin.write('a'.repeat(2100)); // sobre el tope, SIN end()
  await new Promise((res) => setTimeout(res, 500)); // ventana del bug
  assert.equal(child.exitCode, null, // vivo: nada respondió antes de EOF
    `respondió antes de EOF: ${out}`);
  child.kill('SIGINT');
  const code = await Promise.race([
    cierre,
    new Promise((_, rej) => setTimeout(
      () => rej(new Error('sin respuesta al stop')), 8000).unref()),
  ]);
  assert.equal(code, 1, out);
  const salida = JSON.parse(out);
  assert.equal(salida.played, false);
  assert.equal(salida.echo, null);
  assert.equal(salida.truncated, true);
  child.stdin.destroy();
});

// —— leerStdin: unidad y equivalencia exacta con canonizar ——

function conTope(p, ms = 2000) {
  return Promise.race([
    p,
    new Promise((_, rej) => {
      const g = setTimeout(
        () => rej(new Error('leerStdin no resolvió')), ms);
      g.unref();
    }),
  ]);
}

async function leerPorChunks(texto, tamaño, maxChars = 2000) {
  const pt = new PassThrough();
  const promesa = leerStdin(pt, { maxChars });
  if (tamaño === null) {
    pt.write(texto);
  } else {
    for (let i = 0; i < texto.length; i += tamaño) {
      pt.write(texto.slice(i, i + tamaño));
    }
  }
  pt.end();
  return conTope(promesa);
}

test('leerStdin == canonizar: contraejemplos NFC/inaudibles, por chunks', async () => {
  const casos = [
    'x'.repeat(2000) + '\u200B',   // 2001 crudos → 2000 medibles: acepta
    'x'.repeat(2001),              // 2001 medibles: rechaza
    'a\u0301'.repeat(1000),        // 2000 crudos → 1000: acepta
    'a\u0301'.repeat(1001),        // 2002 crudos → 2001: rechaza
    '\u200B'.repeat(5000) + 'hola', // crudo arbitrario → 4: acepta
    'a\u200B\u0301',               // barrera de composición: no compone
  ];
  for (const texto of casos) {
    let canonizado = null;
    let rechaza = false;
    try { canonizado = canonizar(texto, 2000); }
    catch (e) { rechaza = e.code === 'text_too_long'; }
    for (const tamaño of [1, 3, null]) { // 1 estresa la frontera NFC
      const r = await leerPorChunks(texto, tamaño);
      if (rechaza) {
        assert.equal(r.excedido, true,
          `debe rechazar (${texto.length} crudos)`);
      } else {
        assert.equal(r.excedido, undefined);
        assert.equal(r.texto, canonizado);
      }
    }
  }
});

test('leerStdin: cota temprana — excede sin end() y destruye el stream', async () => {
  const pt = new PassThrough();
  const p = leerStdin(pt, { maxChars: 5 });
  pt.write('abcdef'); // pipe queda abierto: sin end()
  assert.equal((await conTope(p)).excedido, true);
  assert.equal(pt.destroyed, true);
});

test('leerStdin: stop durante la espera (pipe abierto) aborta como detenido', async () => {
  const pt = new PassThrough();
  const p = leerStdin(pt, { maxChars: 100 });
  pt.write('hola');
  pedirStop();
  assert.equal((await conTope(p)).detenido, true);
  resetStop(stopGeneration()); // el flag no contamine otras pruebas
});

test('leerStdin: TTY sin tubería → entrada vacía cruda', async () => {
  assert.deepEqual(await leerStdin({ isTTY: true }, { maxChars: 10 }),
    { texto: '', vacio: true });
});

// r4, H-2 — EOF con sólo inaudibles: texto canonizado vacío pero
// crudo NO vacío (la métrica que decide usage).
test('leerStdin: sólo inaudibles → texto canonizado vacío, vacio false', async () => {
  const pt = new PassThrough();
  const p = leerStdin(pt, { maxChars: 100 });
  pt.write('\u200B\u200C');
  pt.end();
  assert.deepEqual(await conTope(p), { texto: '', vacio: false });
});

// r4, H-3 — un error de lectura NO es entrada vacía: marca propia en
// ambos modos, sin texto parcial.
test('leerStdin: error de lectura → errorLectura en ambos modos', async () => {
  for (const drenar of [false, true]) {
    const pt = new PassThrough();
    const p = leerStdin(pt, { maxChars: 100, drenar });
    pt.write('parcial'); // bajo el tope: el fallo decide, no la cota
    pt.emit('error', new Error('x'));
    assert.deepEqual(await conTope(p), { errorLectura: true });
  }
});

// r3, B2 — modo drenaje (motor ausente): vacuidad cruda, sin acotar
test('leerStdin (drenar): sobre el tope NO rechaza — vacuidad cruda al EOF', async () => {
  const pt = new PassThrough();
  const p = leerStdin(pt, { maxChars: 5, drenar: true });
  pt.write('abcdef'); // 6 > 5: en modo cota sería excedido
  pt.end();
  assert.deepEqual(await conTope(p), { vacio: false });
  const vacioPt = new PassThrough();
  const vacioP = leerStdin(vacioPt, { maxChars: 5, drenar: true });
  vacioPt.end(); // cero caracteres
  assert.deepEqual(await conTope(vacioP), { vacio: true });
  assert.deepEqual(await leerStdin({ isTTY: true }, { drenar: true }),
    { vacio: true });
});

test('leerStdin (drenar): stop durante el drenaje (pipe abierto) aborta', async () => {
  const pt = new PassThrough();
  const p = leerStdin(pt, { drenar: true });
  pt.write('hola'); // sin end(): el pipe queda abierto
  pedirStop();
  assert.equal((await conTope(p)).detenido, true);
  assert.equal(pt.destroyed, true);
  resetStop(stopGeneration()); // el flag no contamine otras pruebas
});

// r4, H-3 — mapeo de errorLectura a la taxonomía: speakOp en u stdin que falla a mitad. Sin audio.
const runnerErrorStdin = join(dirSpeak, 'runner-error-stdin.mjs');
writeFileSync(runnerErrorStdin, `import { pathToFileURL } from 'node:url'; import { PassThrough } from 'node:stream';
const { speakOp } = await import(pathToFileURL(process.argv[2]).href);
const pt = new PassThrough();
const promesa = speakOp(['--engine', 'eco', '--text-stdin'], pt);
const tope = Date.now() + 5000;
while (pt.listenerCount('error') === 0 && Date.now() < tope) {
  await new Promise((r) => setTimeout(r, 5));
}
pt.write('parcial'); pt.emit('error', Object.assign(new Error('EIO'), { code: 'EIO' }));
process.stdout.write(JSON.stringify(await promesa));
`);

test('speakOp: error de stdin → internal_error, sin hablar el parcial', () => {
  limpiarMarcadores();
  const r = spawnSync('node',
    ['--import', preload, runnerErrorStdin,
      new URL('../src/ops.mjs', import.meta.url).pathname],
    { encoding: 'utf8', cwd: RAIZ, env: envSinMotor() });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.code, 1);
  assert.equal(out.data.error, 'internal_error');
  // jamás llegó a un motor ni a un reproductor
  assert.equal(existsSync(marcadorEco), false);
  assert.equal(existsSync(marcadorAfplay), false);
});
