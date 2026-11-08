// Timbre JARVIS — cuando opencode termina, glosomata habla.
// Locución adaptativa por niveles:
//   normal → resumen corto con ironía cuando el contenido la justifica
//   hito   → resumen formal de un avance concreto
//   error  → resumen directo del fallo y de la continuación
// Registro: mayordomo británico ("Jarvis ligero": la ironía se gana).
// Dependencia: ~/www/aria/glosomata (si no existe, el plugin no opera).
//
// Ronda adversarial 2026-08-20 (glosomata issue #5, comentario con evidencia):
//   H1/H2: spawn async (spawnSync congelaba el event loop del host durante
//          la síntesis) + cola serializadora (glosomata toma un lock
//          cross-process del canal: dos speaks concurrentes → el 2º muere con
//          channel_busy y la locución se perdería en silencio) + listener
//          "error" del child (spawn emite error; sin listener, excepción en
//          el host). Timeout manual con SIGTERM: glosomata limpia sus grupos
//          de proceso con SIGTERM/SIGINT (SIGKILL dejaría audio huérfano).
//   H3: dedup por Map sessionID→mensajeID (una variable global re-locutaba
//          al intercalar sesiones A/B).
//   H4: clasificación sobre las primeras 2 oraciones + eliminada la clave
//          suelta "adversarial" (falsos "hito" en informes que sólo la
//          mencionan; regla verificada 7/7 contra muestras del log).
//   H5: guard sin mensaje assistant → silencio (antes hablaba "Sin
//          comentarios dignos de mención").
//   H6: node resuelto a ruta absoluta. NO process.execPath: el host es el
//          binario Bun de opencode; ejecutarlo con un .mjs arrancaría otra
//          instancia de opencode, no node.
//
// v3 (2026-08-20, decreto del Mediador):
//   - Marcador 🎙 jarvis: si el agente cierra su respuesta con la línea de
//     convención (AGENTS.md global), se habla VERBATIM: proyecto, área y
//     resumen ya los escribió el modelo en lenguaje humano. El pipeline
//     heurístico queda como fallback cuando la línea falta.
//   - Adiós a los topes de estilo por chars (160/500): la longitud la decide
//     el contexto. Válvulas anti-fuga únicamente (runaway del TTS): marcador
//     1800c (glosomata canoniza a 2000), fallback 900c.
//
// v4 (2026-11-08, mandato timbre-stdin): la locución viaja por stdin del
//   hijo (`speak --text-stdin`) y NINGÚN argv la contiene — argv es visible
//   en `ps` para otros usuarios locales (misma política que ADR-005 de
//   glosomata aplica a sus adaptadores, ahora en la frontera CLI). El exit
//   de `speak` se registra (código, no texto) en vez de descartarse; el log
//   sigue recibiendo sólo eventos y códigos, jamás contenido.

import { existsSync, appendFileSync } from "node:fs"
import { spawn, execFileSync } from "node:child_process"

// Puerto V1→V2 (2026-10-14, opencode 2.0.29): la API de plugins cambió de
// forma rupturista ("Plugin must export a default definition..."). Mapeo:
//   export const TimbreJarvis (V1) → export default Plugin.define({id, setup}) (V2)
//   hook `event` (session.idle)    → ctx.event.subscribe() (data.sessionID tipado)
//   client.session.messages({path}) → ctx.session.context({sessionID}) — API V2:
//     mensajes con `type: "assistant"` y `content[]` (antes info.role/parts).
// Todo lo demás (cola serializadora, dedup H3, marcador v3, válvulas) intacto.

const GLOSOMATA_DIR = `${process.env.HOME}/www/aria/glosomata`
const GLOSOMATA = `${GLOSOMATA_DIR}/src/cli.mjs`
const JARVIS_CONFIG = `${GLOSOMATA_DIR}/glosomata.jarvis.json`
const LOG = `${process.env.HOME}/.config/opencode/timbre-jarvis.log`
// Válvulas anti-fuga (no de estilo): un TTS leyendo una pared de texto.
const VALVULA_MARCADOR = 1800 // glosomata canoniza a 2000: no enviar más
const VALVULA_FALLBACK = 900

const CLAVES_HITO = [
  "fase cerrada", "fase completa", "hitos", "hito", "release", "publicado",
  "lanzado", "tag anotado", "proceed", "apto_para_release",
  "criterio cumplido", "criterios cumplidos", "verificado por adversarial",
  "cerrado el", "queda cerrada", "quedó cerrada", "implementado completo",
  "migración completa",
]

// "crítico" se excluye a propósito: "flujos críticos"/"severidad crítica"
// aparecen en mensajes de éxito y causaban falsos positivos (e2e 2026-08-19).
const CLAVES_ERROR = [
  "error", "fallo", "falló", "fallido", "falla", "roto", "bug",
  "excepción", "bloqueado", "bloqueo", "no funciona", "no se pudo",
  "sin éxito", "regresión", "rechazado", "fix-and-retry",
  "fuera de servicio", "timeout", "denegado",
]

// En éxitos es común "sin errores"/"cero fallos": se eliminan esas
// negaciones antes de clasificar, o un éxito hablaría con tono de fallo.
const NEGACIONES_ERROR =
  /(sin|cero|no hay|ningún|ninguna|sin ningún)\s+(errores?|fallos?|fallas?|bugs?|defectos?|incidencias?|problemas?)/gi

const CLAVES = {
  tests: ["test", "spec", "prueba", "suite", "verde"],
  error: CLAVES_ERROR,
  git: ["commit", "push", "merge", "release", "tag", "branch"],
  docs: ["documenta", "readme", "contrato", "bitácora", "docs"],
}

const IRONIAS = {
  tests: [
    "Tests en verde; contenga el entusiasmo.",
    "Suite sin fallos, por sorpresa de todos.",
  ],
  error: [
    "Hubo un fallo; nadie lleva la cuenta. Yo, quizá.",
    "Algo se rompió; el carácter se construye con esto.",
  ],
  git: [
    "Commit servido; internet nunca olvida.",
    "Publicado para la posteridad, advertido está.",
  ],
  docs: [
    "Docs al día; nadie las leerá.",
    "Bitácora actualizada; futura arqueología.",
  ],
  default: [
    "He terminado; no se acostumbre.",
    "Todo listo, sin propina alguna.",
    "Servido; no tenía otra opción.",
    "Concluido; placer es mucho decir.",
    "Listo, señor. Usted dirá.",
  ],
}

const CIERRES_HITO = [
  "Un hito digno de mención, señor.",
  "Constancia británica: los hitos se anuncian con sobriedad.",
  "Progreso tangible, por fin.",
]

let contador = 0

// Dedup cross-instancia: V2 carga el plugin por ubicación y el hot-reload
// re-evalúa el módulo, así que el Map a nivel de módulo NO se comparte entre
// copias (hallazgo en vivo: locución doble 2026-10-14). El proceso del
// servicio es uno: el estado vive en globalThis y sobrevive recargas.
// H3: dedup por sesión+mensaje. H2: cola serializadora única (glosomata toma
// lock cross-process del canal; dos colas concurrentes pierden locuciones).
const __timbre = (globalThis.__timbreJarvis ??= { dedup: new Map(), cola: Promise.resolve() })

function contiene(texto, claves) {
  const t = texto.toLowerCase()
  return claves.some((k) => t.includes(k))
}

function elegirIronia(texto) {
  const t = texto.toLowerCase()
  for (const [categoria, palabras] of Object.entries(CLAVES)) {
    if (palabras.some((p) => t.includes(p))) {
      const pool = IRONIAS[categoria]
      return pool[contador++ % pool.length]
    }
  }
  return IRONIAS.default[contador++ % IRONIAS.default.length]
}

function limpiar(texto) {
  return texto
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_#>~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function oraciones(texto) {
  return limpiar(texto).split(/(?<=[.!?])\s+/).filter(Boolean)
}

function resumirCorto(texto, maxOraciones = 2) {
  const partes = oraciones(texto).slice(0, maxOraciones)
  return partes.join(" ").trim()
}

function resumirLargo(texto, maxOraciones = 5) {
  const partes = oraciones(texto).slice(0, maxOraciones)
  return partes.join(" ").trim()
}

function clasificar(texto) {
  const limpio = limpiar(texto).replace(NEGACIONES_ERROR, " ")
  // El error domina: un fallo en medio de un hito sigue siendo un fallo.
  if (contiene(limpio, CLAVES_ERROR)) return "error"
  if (contiene(limpio, CLAVES_HITO)) return "hito"
  return "normal"
}

// H4: la clasificación corre sólo sobre las primeras 2 oraciones — lo que el
// agente dice primero es lo que hizo; citas de issues y contexto histórico
// van después (regla verificada 7/7, ver comentario en glosomata issue #5).
const VENTANA_ORACIONES = 2
function clasificarVentana(texto) {
  const primeras = oraciones(texto).slice(0, VENTANA_ORACIONES).join(" ")
  return clasificar(primeras)
}

function componer(texto) {
  const nivel = clasificarVentana(texto)
  if (nivel === "error") {
    const cierre = "Le sugiero revisar los detalles en pantalla."
    const resumen = resumirLargo(texto)
    return `Señor, un contratiempo. ${resumen.replace(/\.+$/, "")}. ${cierre}`
  }
  if (nivel === "hito") {
    const cierre = CIERRES_HITO[contador++ % CIERRES_HITO.length]
    const resumen = resumirLargo(texto)
    return `Señor, excelentes noticias. ${resumen.replace(/\.+$/, "")}. ${cierre}`
  }
  const resumen = texto ? resumirCorto(texto) : "Sin comentarios dignos de mención"
  const ironia = elegirIronia(resumen)
  return `Señor. ${resumen.replace(/\.+$/, "")}. ${ironia}`
}

// v3: extracción del marcador de convención. Tolerante a variación de
// presentación (emoji con/sin selector VS16, mayúsculas, espacios).
const RE_MARCADOR = /^[ \t]*\u{1F399}\uFE0F?[ \t]*jarvis:[ \t]*(.+)$/gimu
function extraerMarcador(texto) {
  if (!texto) return null
  for (const linea of texto.matchAll(RE_MARCADOR)) {
    const contenido = linea[1].trim()
    if (contenido) return contenido
  }
  return null
}

// v3: longitud por contexto. El marcador se habla tal cual (el modelo ya
// modulará: 1-3 oraciones); sólo válvula anti-fuga.
function locucionDesdeMarcador(marcador) {
  return marcador.length > VALVULA_MARCADOR
    ? marcador.slice(0, VALVULA_MARCADOR - 3) + "..."
    : marcador
}

// Fallback sin marcador: clases por densidad de contenido (oraciones), no
// chars; válvula como cota extrema.
function locucionFallback(texto) {
  const locucion = componer(texto)
  return locucion.length > VALVULA_FALLBACK
    ? locucion.slice(0, VALVULA_FALLBACK - 3) + "..."
    : locucion
}

// H6: ruta absoluta a node, con fallbacks. Nunca process.execPath (ver H6).
function resolverNode() {
  try {
    const p = execFileSync("which", ["node"], { encoding: "utf8" }).trim()
    if (p && existsSync(p)) return p
  } catch {}
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    if (existsSync(p)) return p
  }
  return "node"
}
const NODE = resolverNode()

// H2: cola serializadora — una locución a la vez, compartida entre instancias
// vía __timbre (ver nota arriba). La promesa nunca rechaza: el timbre jamás
// debe romper la sesión.
//
// v4: spawn y registro inyectables para los tests del repo (capturan argv y
// stdin sin tocar ~/.config, sin SDK de opencode y sin audio real). El
// registro recibe SÓLO eventos y códigos; jamás contenido de la locución.
function registrarEnLog(linea) {
  appendFileSync(LOG, linea, { mode: 0o600 })
}

export function crearHablar(spawnFn = spawn, registrar = registrarEnLog) {
  return function hablar(locucion) {
    __timbre.cola = __timbre.cola.then(
      () =>
        new Promise((resolve) => {
          let terminado = false
          const registrarSeguro = (linea) => {
            try {
              registrar(linea)
            } catch {} // un fallo de log jamás rompe la cola
          }
          const fin = () => {
            if (terminado) return
            terminado = true
            clearTimeout(temporizador)
            resolve()
          }
          // v4: la locución NO va en argv (visible en ps) — viaja por stdin.
          const child = spawnFn(
            NODE,
            [GLOSOMATA, "speak", "--engine", "phonon-rebeca", "--text-stdin"],
            { cwd: GLOSOMATA_DIR, stdio: ["pipe", "ignore", "ignore"],
              env: { ...process.env, GLOSOMATA_CONFIG: JARVIS_CONFIG } }
          )
          const temporizador = setTimeout(() => {
            try {
              child.kill("SIGTERM")
            } catch {}
          }, 120000)
          child.on("error", (e) => {
            registrarSeguro(
              `[${new Date().toISOString()}] speak error ${e.code ?? "internal_error"}\n`
            )
            fin()
          })
          // v4: el exit de speak se conserva como código (no texto). Exit 0
          // no registra nada; señal/timeout queda como "senal".
          child.on("close", (code) => {
            if (code !== 0) {
              registrarSeguro(
                `[${new Date().toISOString()}] speak exit ${code ?? "senal"}\n`
              )
            }
            fin()
          })
          // EPIPE: si speak muere antes de leer stdin (p.ej. usage temprano),
          // write/end fallan aquí; 'close' ya viene — no rompe el host.
          child.stdin.on("error", () => {})
          child.stdin.write(locucion)
          child.stdin.end()
        })
    )
    return __timbre.cola
  }
}
const hablar = crearHablar()

// v3.1 (2026-08-20, decreto Mediador: "más Jarvis", nivel 2): marco vocal
// determinista — toda locución abre con "Señor." salvo que ya lo contenga
// (dedup). Las variantes de registro ("He de informar que...") las escribe
// el modelo vía instrucción global; el plugin solo enmarca. La ironía se
// gana (decreto "Jarvis ligero"): nada teatral aquí.
function conMarco(locucion) {
  return /\bse[nñ]or\b/i.test(locucion) ? locucion : `Señor. ${locucion}`
}

// --- fin de la parte extraíble para tests ---

// El SDK de opencode sólo existe dentro del host. Carga diferida con
// try/catch: el repo es cero-dependencias y el import falla fuera del
// host; los tests inyectan un cargador simulado (ver inyección abajo).
async function cargarPluginSdk() {
  try {
    return (await import("@opencode/plugin")).Plugin
  } catch {
    return null
  }
}

// v4.1 (corrección r2, hallazgo 3 de la revisión): la definición V2 se
// separa del entrypoint y se vuelve comprobable — con un SDK simulado,
// crearDefinicionPlugin debe producir una definición default válida.
// Una carga fallida del SDK jamás es un `default null` silencioso: el
// código (sdk_no_disponible / sdk_invalido) se registra en el log del
// plugin y en stderr del host — fallo de integración distinguible de
// plugin ausente.
//
// Inyección para tests del repo: se lee UNA vez al iniciar el módulo,
// ANTES de la primera importación (el host no define este global y
// corre los defaults de producción):
//   globalThis.__timbreJarvisInyeccion = { cargarSdk?, registrarCargaFallida? }
const __inyeccion = globalThis.__timbreJarvisInyeccion ?? {}
const cargarSdk = __inyeccion.cargarSdk ?? cargarPluginSdk
const registrarCargaFallida = __inyeccion.registrarCargaFallida
  ?? ((codigo) => {
    try {
      registrarEnLog(`[${new Date().toISOString()}] plugin ${codigo}\n`)
    } catch {}
    console.error(`timbre-jarvis: ${codigo}`)
  })

export function crearDefinicionPlugin(Plugin) {
  return Plugin.define({
  id: "timbre-jarvis",
  setup(ctx) {
    const disponible = existsSync(GLOSOMATA)
    if (disponible) {
      appendFileSync(LOG, `[${new Date().toISOString()}] plugin cargado\n`, { mode: 0o600 })
    }
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          // V2 no emite "session.idle" (verificado con tally en vivo 2026-10-14):
          // el fin de turno es session.execution.succeeded.
          if (event?.type !== "session.execution.succeeded" || !event.data?.sessionID) continue
          if (!disponible) continue
          const sessionID = event.data.sessionID
          try {
            const mensajes = await ctx.session.context({ sessionID })
            if (!Array.isArray(mensajes)) continue
            let texto = null
            let mensajeID = null
            for (let i = mensajes.length - 1; i >= 0; i--) {
              const m = mensajes[i]
              if (m?.type !== "assistant") continue
              const parte = Array.isArray(m.content)
                ? m.content.find((p) => p?.type === "text" && typeof p.text === "string" && p.text.trim())
                : null
              if (parte) {
                texto = parte.text
                mensajeID = m.id
                break
              }
            }
            // H5: sesión sin mensaje assistant con texto → silencio.
            if (!mensajeID) continue
            if (__timbre.dedup.get(sessionID) === mensajeID) continue
            // Poda: el host vive días; sin cota, el Map crece sin límite.
            if (__timbre.dedup.size >= 128) {
              const primera = __timbre.dedup.keys().next().value
              if (primera !== undefined) __timbre.dedup.delete(primera)
            }
            __timbre.dedup.set(sessionID, mensajeID)
            const marcador = extraerMarcador(texto)
            const cruda = marcador
              ? locucionDesdeMarcador(marcador)
              : locucionFallback(texto ?? "")
            hablar(conMarco(cruda))
          } catch {
            // El timbre jamás debe romper la sesión: fallo silencioso.
          }
        }
      } catch {
        if (!controller.signal.aborted) {
          try {
            appendFileSync(LOG, `[${new Date().toISOString()}] event stream: internal_error\n`, { mode: 0o600 })
          } catch {}
        }
      }
    })()
    return () => {
      controller.abort()
    }
  },
  })
}

const Plugin = await cargarSdk()
let definicion = null
if (Plugin && typeof Plugin.define === "function") {
  definicion = crearDefinicionPlugin(Plugin)
} else {
  // fallo de integración EXPLÍCITO, jamás un default null silencioso
  // (código, no contenido). En el host: log del plugin + stderr.
  registrarCargaFallida(Plugin ? "sdk_invalido" : "sdk_no_disponible")
}
export default definicion
