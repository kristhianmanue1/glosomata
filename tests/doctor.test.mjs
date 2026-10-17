import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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
