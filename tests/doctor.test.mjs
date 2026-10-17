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

const CAUSAS_CERRADAS = new Set([
  'plataforma_no_soportada', 'afplay_ausente', 'binario_ausente',
  'modelo_ausente', 'python_ausente', 'script_ausente', 'sin_kill_switch',
  'adapter_desconocido', 'probe_fallido',
]);

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

test('doctor: motores con rutas ausentes → causas del conjunto cerrado', () => {
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
  for (const t of d.tts) {
    assert.equal(t.available, false, t.id);
    assert.ok(CAUSAS_CERRADAS.has(t.causa), `causa cerrada: ${t.causa}`);
  }
  assert.equal(d.stt.whisper.ok, false);
  assert.equal(d.stt.whisper.causa, 'whisper_bin_ausente');
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
