// Contrato del plugin timbre-jarvis (mandato timbre-stdin, 2026-11-08;
// corrección r2): la locución viaja por stdin del hijo
// `glosomata speak --text-stdin` y NINGÚN argv la contiene — argv es
// visible en `ps` para otros usuarios locales (política ADR-005 de
// glosomata). Spawn y log INYECTADOS: sin tocar ~/.config, sin SDK de
// opencode y sin reproducir audio real.
//
// La carga del SDK también es inyectable: se define en globalThis ANTES
// de la primera importación (el plugin la lee una sola vez al iniciar).
// El repo no tiene @opencode/plugin y el registro de carga fallida de
// producción escribe en ~/.config — los tests lo capturan aquí. No se
// llama a setup() en ningún test: en un host real escribe en el log del
// plugin (setup se verifica por forma, no por ejecución).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const eventosCarga = [];
const inyeccionBase = {
  cargarSdk: async () => null, // repo: sin SDK, como producción sin host
  registrarCargaFallida: (codigo) => eventosCarga.push(codigo),
};
globalThis.__timbreJarvisInyeccion = inyeccionBase;

const mod = await import('../integrations/opencode/timbre-jarvis.js');
const { crearHablar, crearDefinicionPlugin } = mod;

// Hijo falso: captura argv y stdin; emite 'close' cuando el plugin
// cierra stdin (como el proceso real: el exit llega tras el EOF).
function spawnFake(capturas, codigoSalida = 0) {
  return (cmd, argv, opts) => {
    const hijo = new EventEmitter();
    hijo.kill = () => {};
    const partes = [];
    let cerroStdin = false;
    hijo.stdin = Object.assign(new EventEmitter(), {
      write: (t) => partes.push(t),
      end: () => {
        if (cerroStdin) return;
        cerroStdin = true;
        process.nextTick(() => hijo.emit('close', codigoSalida));
      },
    });
    Object.assign(hijo, { __partes: partes, __cerroStdin: () => cerroStdin });
    capturas.push({ cmd, argv, opts, hijo });
    return hijo;
  };
}

test('plugin: la locución llega íntegra por stdin y ningún argv la contiene', async () => {
  const locucion = 'Señor. LOCUCION-PRIVADA-que-ps-no-debe-ver.';
  const capturas = [];
  const logs = [];
  const hablar = crearHablar(spawnFake(capturas), (l) => logs.push(l));
  await hablar(locucion);
  assert.equal(capturas.length, 1);
  const { cmd, argv, opts, hijo } = capturas[0];
  // llama a node con el CLI de glosomata…
  assert.ok(cmd.includes('node'));
  assert.ok(argv[0].endsWith('src/cli.mjs'));
  // …con speak por stdin y SIN --text
  assert.deepEqual(argv.slice(1),
    ['speak', '--engine', 'phonon-rebeca', '--text-stdin']);
  // stdin conectado (no 'ignore'): por ahí viaja la locución
  assert.equal(opts.stdio[0], 'pipe');
  // la locución llegó íntegra y stdin quedó cerrado
  assert.equal(hijo.__partes.join(''), locucion);
  assert.equal(hijo.__cerroStdin(), true);
  // exit 0 no registra nada
  assert.deepEqual(logs, []);
});

test('plugin: exit != 0 de speak se registra como código, sin contenido', async () => {
  const locucion = 'Señor. SECRETO-que-tampoco-va-al-log.';
  const capturas = [];
  const logs = [];
  const hablar = crearHablar(spawnFake(capturas, 1), (l) => logs.push(l));
  await hablar(locucion);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /speak exit 1/);
  assert.ok(!logs[0].includes('SECRETO'), 'el log sólo lleva códigos');
});

test('plugin: sin SDK el default es null Y el fallo de carga queda registrado', () => {
  // nunca silencioso (hallazgo 3 de la revisión): null + evento explícito
  assert.equal(mod.default, null);
  assert.ok(eventosCarga.includes('sdk_no_disponible'),
    'la desactivación debe quedar registrada con código');
});

test('plugin: crearDefinicionPlugin con SDK simulado produce definición V2 válida', () => {
  const definiciones = [];
  const sdkSim = {
    define: (d) => {
      definiciones.push(d);
      return { __sdk: 'simulado', definicion: d };
    },
  };
  const def = crearDefinicionPlugin(sdkSim);
  assert.equal(def.__sdk, 'simulado');
  assert.equal(definiciones.length, 1);
  assert.equal(definiciones[0].id, 'timbre-jarvis');
  assert.equal(typeof definiciones[0].setup, 'function');
});

// Instancias frescas por query string (caché ESM por URL): el entrypoint
// re-evalúa y lee la inyección vigente al iniciar el módulo.
test('plugin: entrypoint con SDK simulado exporta default válido (no null)', async () => {
  const antes = eventosCarga.length;
  try {
    globalThis.__timbreJarvisInyeccion = {
      cargarSdk: async () => ({
        define: (d) => ({ __sdk: 'simulado', definicion: d }),
      }),
      registrarCargaFallida: (c) => eventosCarga.push(c),
    };
    const modSim = await import(
      '../integrations/opencode/timbre-jarvis.js?sdk-simulado');
    assert.notEqual(modSim.default, null);
    assert.equal(modSim.default.__sdk, 'simulado');
    assert.equal(modSim.default.definicion.id, 'timbre-jarvis');
    assert.equal(typeof modSim.default.definicion.setup, 'function');
    assert.equal(eventosCarga.length, antes); // sin fallo registrado
  } finally {
    globalThis.__timbreJarvisInyeccion = inyeccionBase;
  }
});

test('plugin: SDK que carga sin define → sdk_invalido, default null', async () => {
  const antes = eventosCarga.length;
  try {
    globalThis.__timbreJarvisInyeccion = {
      cargarSdk: async () => ({ version: 99 }), // sin .define
      registrarCargaFallida: (c) => eventosCarga.push(c),
    };
    const modInv = await import(
      '../integrations/opencode/timbre-jarvis.js?sdk-invalido');
    assert.equal(modInv.default, null);
    assert.equal(eventosCarga.length, antes + 1);
    assert.equal(eventosCarga[eventosCarga.length - 1], 'sdk_invalido');
  } finally {
    globalThis.__timbreJarvisInyeccion = inyeccionBase;
  }
});
