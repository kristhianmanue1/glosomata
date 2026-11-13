import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RAIZ = new URL('..', import.meta.url).pathname;

function configTemporal(contenido) {
  const dir = mkdtempSync(join(tmpdir(), 'glosomata-doctor-'));
  const ruta = join(dir, 'glosomata.json');
  writeFileSync(ruta,
    typeof contenido === 'string' ? contenido : JSON.stringify(contenido));
  return ruta;
}

function doctor(env = {}) {
  try {
    const out = execFileSync('node', ['src/cli.mjs', 'doctor'], {
      encoding: 'utf8',
      cwd: RAIZ,
      env: { ...process.env, ...env },
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: String(e.stdout ?? '') };
  }
}

test('doctor: config ilegible → exit 1, config_unreadable con detalle, sin tts', () => {
  const ruta = configTemporal('{esto no es json');
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.equal(d.config.ok, false);
  assert.equal(d.config.code, 'config_unreadable');
  assert.equal(typeof d.config.detalle, 'string');
  assert.deepEqual(d.tts, []);
  assert.equal(d.stt.whisper.ok, false);
  assert.equal(d.stt.whisper.causa, 'config_unreadable');
  assert.equal(d.node.ok, true);
  assert.equal(d.node.version, process.versions.node);
  assert.equal(typeof d.stt.ffmpeg.ok, 'boolean');
});

test('doctor: motores con rutas ausentes → causa exacta por motor', (t) => {
  const enDarwin = process.platform === 'darwin';
  const ruta = configTemporal({
    engines: {
      tts: [
        { id: 'piper-roto', adapter: 'piper', bin: '/no/existe/piper',
          model: '/no/existe/modelo.onnx', selected: false,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 500 } },
        { id: 'kokoro-roto', adapter: 'kokoro', python: '/no/existe/python',
          model: '/no/existe/modelo', selected: false,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 300 } },
      ],
      stt: { whisper_bin: '/no/existe/whisper-cli',
        whisper_model: '/no/existe/ggml.bin' },
    },
    constraints: {},
  });
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.equal(d.config.ok, true);
  assert.equal(d.tts.length, 2);
  // orden de dependencia del diagnóstico: plataforma → afplay → resto
  const esperadoPiper = enDarwin ? 'binario_ausente' : 'plataforma_no_soportada';
  const esperadoKokoro = enDarwin ? 'python_ausente' : 'plataforma_no_soportada';
  assert.equal(d.tts.find((x) => x.id === 'piper-roto').causa, esperadoPiper);
  assert.equal(d.tts.find((x) => x.id === 'kokoro-roto').causa, esperadoKokoro);
  assert.equal(d.stt.whisper.ok, false);
  assert.equal(d.stt.whisper.causa, 'whisper_bin_ausente');
});

test('doctor: lfm3 sin credencial → causa auth_ausente (§7.1)', (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (curl/afplay)');
  const ruta = configTemporal({
    engines: {
      tts: [
        { id: 'lfm3-sin-auth', adapter: 'lfm3',
          auth_file: '/no/existe/auth-glosomata.txt', selected: false,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 500 } },
      ],
      stt: { whisper_bin: '/no/existe/w', whisper_model: '/no/existe/m' },
    },
    constraints: {},
  });
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.equal(d.tts[0].available, false);
  assert.equal(d.tts[0].causa, 'auth_ausente');
});

test('doctor: todo operativo → exit 0 (camino verde del contrato)', (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (say/afplay)');
  const ruta = configTemporal({
    engines: {
      tts: [
        { id: 'say-ok', adapter: 'say', selected: true,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 200 } },
      ],
      stt: { whisper_bin: '/usr/bin/say', whisper_model: '/usr/bin/say' },
    },
    constraints: {},
  });
  const { code, out } = doctor({
    GLOSOMATA_CONFIG: ruta, GLOSOMATA_FFMPEG: '/usr/bin/say',
  });
  assert.equal(code, 0);
  const d = JSON.parse(out);
  assert.equal(d.node.ok, true);
  assert.equal(d.config.ok, true);
  assert.equal(d.tts[0].available, true);
  assert.equal(d.stt.whisper.ok, true);
  assert.equal(d.stt.ffmpeg.ok, true);
});

test('doctor: GLOSOMATA_FFMPEG ausente → ffmpeg_ausente', () => {
  const ruta = configTemporal({
    engines: { tts: [], stt: { whisper_bin: '/no/existe/w',
      whisper_model: '/no/existe/m' } },
    constraints: {},
  });
  const { code, out } = doctor({
    GLOSOMATA_CONFIG: ruta, GLOSOMATA_FFMPEG: '/no/existe/ffmpeg',
  });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.equal(d.stt.ffmpeg.ok, false);
  assert.equal(d.stt.ffmpeg.causa, 'ffmpeg_ausente');
});

test('doctor: adapter desconocido → adapter_desconocido', () => {
  const ruta = configTemporal({
    engines: {
      tts: [
        { id: 'misterio', adapter: 'foo', selected: false,
          kill_switch: { type: 'subprocess_kill', target: 'process_group',
            max_latency_ms: 100 } },
      ],
      stt: { whisper_bin: '/no/existe/w', whisper_model: '/no/existe/m' },
    },
    constraints: {},
  });
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.equal(d.tts[0].causa, 'adapter_desconocido');
});

test('doctor: engines.tts vacío → exit 1, tts[] vacío sin causa extra', () => {
  const ruta = configTemporal({
    engines: { tts: [], stt: { whisper_bin: '/no/existe/w',
      whisper_model: '/no/existe/m' } },
    constraints: {},
  });
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.deepEqual(d.tts, []);
  assert.equal(d.config.ok, true);
});

test('doctor: engines.tts:[null] → config_unreadable con detalle real', () => {
  // el diagnóstico no puede mentir: la causa es estructural, no "undefined"
  const ruta = configTemporal({
    engines: { tts: [null], stt: { whisper_bin: '/no/existe/w',
      whisper_model: '/no/existe/m' } },
    constraints: {},
  });
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  assert.equal(d.config.ok, false);
  assert.equal(d.config.code, 'config_unreadable');
  assert.match(d.config.detalle, /estructura inválida/);
  assert.notEqual(d.config.detalle, 'undefined');
});

test('doctor: motor sin kill_switch → sin_kill_switch, probe no corre', () => {
  // rutas válidas NO importan: sin kill_switch el motor muere antes del probe
  const ruta = configTemporal({
    engines: {
      tts: [
        { id: 'say-sin-kill', adapter: 'say', selected: true },
      ],
      stt: { whisper_bin: '/no/existe/whisper-cli',
        whisper_model: '/no/existe/ggml.bin' },
    },
    constraints: {},
  });
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  assert.equal(code, 1);
  const d = JSON.parse(out);
  const say = d.tts.find((t) => t.id === 'say-sin-kill');
  assert.equal(say.available, false);
  assert.equal(say.causa, 'sin_kill_switch');
});

// —— G2a2: advisory de preferencia de entrada (INFORMATIVO: reporta si
// hay preferencia y si resuelve; JAMÁS afecta el exit del veredicto) ——

const LISTADO_PREF = [
  '[AVFoundation indev @ 0x1] AVFoundation audio devices:',
  '[AVFoundation indev @ 0x1] [0] Entrada Cero',
  '[AVFoundation indev @ 0x1] [1] Entrada Uno',
  '[AVFoundation indev @ 0x1] [2] Entrada Doble',
  '[AVFoundation indev @ 0x1] [3] Entrada Doble',
].join('\n');

const dirPref = mkdtempSync(join(tmpdir(), 'glosomata-doctor-g2-'));
function falsoPref(nombre, cuerpo) {
  const ruta = join(dirPref, nombre);
  writeFileSync(ruta, `#!/usr/bin/env node\n${cuerpo}\n`);
  chmodSync(ruta, 0o755);
  return ruta;
}
const ffmpegPref = falsoPref('ffmpeg-pref',
  `process.stderr.write(${JSON.stringify(LISTADO_PREF)});process.exit(251);`);
const ffmpegPrefBasura = falsoPref('ffmpeg-pref-basura',
  `process.stderr.write('basura\\nsin seccion\\n');process.exit(1);`);

test('doctor: preferencia resuelve → advisory presente, exit intacto', (t) => {
  if (process.platform !== 'darwin') {
    return t.skip('el listado avfoundation sólo se consulta en darwin');
  }
  const con = configTemporal({
    engines: { tts: [], stt: { input_device: 'Entrada Cero' } },
    constraints: {},
  });
  const sin = configTemporal({
    engines: { tts: [], stt: {} },
    constraints: {},
  });
  const rCon = doctor({ GLOSOMATA_CONFIG: con, GLOSOMATA_FFMPEG: ffmpegPref });
  const rSin = doctor({ GLOSOMATA_CONFIG: sin, GLOSOMATA_FFMPEG: ffmpegPref });
  // el advisory jamás decide el exit: mismo veredicto con y sin preferencia
  assert.equal(rCon.code, rSin.code);
  const d = JSON.parse(rCon.out);
  assert.deepEqual(d.stt.input_device,
    { name: 'Entrada Cero', resuelve: true });
  assert.equal(JSON.parse(rSin.out).stt.input_device, undefined);
});

test('doctor: preferencia ausente → device_missing advisory; homónima → detalle', (t) => {
  if (process.platform !== 'darwin') return t.skip('listado sólo en darwin');
  const ausente = configTemporal({
    engines: { tts: [], stt: { input_device: 'Entrada Fantasma' } },
    constraints: {},
  });
  const r = doctor({ GLOSOMATA_CONFIG: ausente, GLOSOMATA_FFMPEG: ffmpegPref });
  const d = JSON.parse(r.out);
  assert.deepEqual(d.stt.input_device,
    { name: 'Entrada Fantasma', resuelve: false, causa: 'device_missing' });

  const ambigua = configTemporal({
    engines: { tts: [], stt: { input_device: 'Entrada Doble' } },
    constraints: {},
  });
  const r2 = doctor({ GLOSOMATA_CONFIG: ambigua, GLOSOMATA_FFMPEG: ffmpegPref });
  const d2 = JSON.parse(r2.out);
  assert.equal(d2.stt.input_device.resuelve, false);
  assert.equal(d2.stt.input_device.causa, 'device_missing');
  assert.equal(d2.stt.input_device.detalle, 'nombre ambiguo: 2 coincidencias');
});

test('doctor: preferencia con forma inválida → forma_invalida (sin listar)', (t) => {
  // sin GLOSOMATA_FFMPEG: la forma se juzga ANTES de cualquier sonda
  const ruta = configTemporal({
    engines: { tts: [], stt: { input_device: 'a:b' } },
    constraints: {},
  });
  const { code, out } = doctor({ GLOSOMATA_CONFIG: ruta });
  const d = JSON.parse(out);
  assert.deepEqual(d.stt.input_device,
    { name: 'a:b', resuelve: false, causa: 'forma_invalida' });
  // el exit sigue siendo el del veredicto base (tts vacío → 1)
  assert.equal(code, 1);
});

test('doctor: listado ilegible con preferencia → device_list_unavailable', (t) => {
  if (process.platform !== 'darwin') return t.skip('listado sólo en darwin');
  const ruta = configTemporal({
    engines: { tts: [], stt: { input_device: 'Entrada Uno' } },
    constraints: {},
  });
  const r = doctor({
    GLOSOMATA_CONFIG: ruta, GLOSOMATA_FFMPEG: ffmpegPrefBasura,
  });
  const d = JSON.parse(r.out);
  // ni resuelve ni ausente: no pude verificar el inventario
  assert.deepEqual(d.stt.input_device,
    { name: 'Entrada Uno', resuelve: null, causa: 'device_list_unavailable' });
});

test('doctor: preferencia en host sin darwin → plataforma_no_soportada', (t) => {
  if (process.platform === 'darwin') {
    return t.skip('sólo observable en hosts no-darwin (CI linux)');
  }
  const ruta = configTemporal({
    engines: { tts: [], stt: { input_device: 'Entrada Uno' } },
    constraints: {},
  });
  const r = doctor({ GLOSOMATA_CONFIG: ruta, GLOSOMATA_FFMPEG: ffmpegPref });
  const d = JSON.parse(r.out);
  assert.deepEqual(d.stt.input_device,
    { name: 'Entrada Uno', resuelve: false, causa: 'plataforma_no_soportada' });
});

after(() => rmSync(dirPref, { recursive: true, force: true }));

// VAD (2026-11-13): sección sólo si se declara; declarado-but-roto
// tumba el exit (criterio diar).
const CFG_VERDE = (stt) => ({
  engines: {
    tts: [{ id: 'say-ok', adapter: 'say', selected: true,
      kill_switch: { type: 'subprocess_kill', target: 'process_group',
        max_latency_ms: 200 } }],
    stt: { whisper_bin: '/usr/bin/say', whisper_model: '/usr/bin/say', ...stt },
  },
  constraints: {},
});

test('doctor: VAD sano → sección ok y exit 0; sin declarar → sin sección', (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (say/afplay)');
  const env = { GLOSOMATA_FFMPEG: '/usr/bin/say' };
  const sano = doctor({ ...env, GLOSOMATA_CONFIG: configTemporal(CFG_VERDE({
    vad_bin: '/usr/bin/say', vad_model: '/usr/bin/say' })) });
  assert.equal(sano.code, 0);
  assert.deepEqual(JSON.parse(sano.out).stt.vad, { ok: true });
  const sin = doctor({ ...env, GLOSOMATA_CONFIG: configTemporal(CFG_VERDE({})) });
  assert.equal(sin.code, 0);
  assert.equal('vad' in JSON.parse(sin.out).stt, false);
});

test('doctor: VAD declarado y roto → exit 1 con causa cerrada', (t) => {
  if (process.platform !== 'darwin') return t.skip('requiere darwin (say/afplay)');
  const r = doctor({ GLOSOMATA_FFMPEG: '/usr/bin/say',
    GLOSOMATA_CONFIG: configTemporal(CFG_VERDE({
      vad_bin: '/usr/bin/say', vad_model: '/no/existe' })) });
  assert.equal(r.code, 1);
  assert.deepEqual(JSON.parse(r.out).stt.vad,
    { ok: false, causa: 'vad_model_ausente' });
});
