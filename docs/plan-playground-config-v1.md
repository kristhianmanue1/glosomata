# Plan de playground y configuración — v1

> **Estado:** PROPUESTA (v2 tras ronda adversarial). Ejecución sólo con
> aceptación del humano, tarea por tarea. Complementa
> `docs/adr/ADR-008-servidor-local-playground.md` (reabre el no-objetivo
> HTTP de forma acotada) y `docs/specs/contrato-consumo-agentes-v1.md`.
> Sigue el estándar de `docs/estandar-diseno-software-github.md`.

## Reglas de ejecución

1. Una rama por tarea, commit atómico, suite verde y `check_sizes.py`
   OK antes de declarar hecha.
2. Test que reproduce primero para bugs; test nuevo para conducta nueva.
   Sin mocks donde el contrato es observable por proceso.
3. Ronda adversarial (subagente fresco) para tareas **ADV**: parsing de
   config, escritura atómica, servidor HTTP — todo lo que abre frontera.
4. Push, merge y tags: autorización humana una por una.
5. Docs, taxonomía y enumeraciones cerradas se actualizan en el MISMO
   commit que la conducta.
6. **Límite explícito**: este plan aprobado NO autoriza ejecución — cada
   tarea arranca con instrucción posterior del humano.

Leyenda: S ≤ media sesión; M ≤ una sesión.

---

## P0 — Fundamentos de contrato (docs y esquema)

### P0.1 ADR-008 a aceptado + barrido completo de docs — M
La frontera HTTP cambia y CINCO documentos la mencionan; todos se
actualizan en el mismo commit:
- ADR-008: PROPUESTA → aceptado (decisión humana explícita).
- `specs-y-contratos-v1.md` §No objetivos: HTTP queda acotado a
  «servidor de loopback del playground (ADR-008)»; socket/streaming y
  HTTP hacia redes externas siguen prohibidos.
- `contrato-consumo-agentes-v1.md` §2.6 (mismo ajuste) y §1 fila
  «Cliente HTTP/remoto»: pasa a «loopback local (ADR-008); externo:
  no-objetivo».
- `README.md`: «sin navegador» (§1) → «playground web local (loopback)
  desde v1.1 (ADR-008)»; las menciones de §Comandos y §Estructura se
  editan en los commits de P1 y P3 (cuando `config` y `serve` existan),
  no en P0.1 — ahí sólo se ajusta la frase de §1.
- `SECURITY.md`: «sin socket, sin HTTP» → superficie de loopback con
  token + modelo de amenazas del ADR (ver §Amenazas del ADR).
- `guia-mcp.md` y spec §MCP «sin socket/HTTP»: sin cambio de fondo,
  se aclara «(transporte MCP)» para no heredar la ambigüedad.
- **Criterio**: `grep -ri "http\|navegador\|socket"` sobre los docs
  canónicos no arroja ninguna afirmación contradictoria con ADR-008.

### P0.2 Schema formal de `glosomata.json` — M — **ADV**
- `docs/schemas/glosomata-config-v1.schema.json`: esquema cerrado con el
  conjunto de claves CERRADO CONTRA EL CÓDIGO (no contra el ejemplo):
  `{id, adapter (enum say|piper|kokoro), selected, kill_switch,
  bin?, model?, python?, script?, voice?, rate?, pitch_scale?
  (CONTRATO NUEVO — hoy el código no valida rango; propuesta 0.8–1.2),
  sample_rate?}` — `script` (kokoro.mjs), `rate` (say.mjs) y
  `sample_rate` (piper.mjs) existen en código y faltaban en el borrador.
- `constraints`: los rangos son CONTRATO NUEVO (hoy `matriz.mjs` no
  valida constraints); las claves sin lector en `src/`
  (`validation_floor_ms`, `confirmation_channels`, `max_pattern_chars`)
  se marcan `deprecated` en el schema hasta que el código las lea.
- `matriz.mjs` sigue siendo la autoridad en runtime; el schema es
  referencia formal y base del editor (P4.2).
- Tests: `glosomata.example.json` valida Y una config que ejerza TODAS
  las claves opcionales valida (el example solo pasaría vacío).
- Coordinación de planes: si C3 del plan de consumo aterriza después
  (clave `templates`), el schema crece en ESE commit («sólo crece»).
- §matriz del spec canónico se actualiza en el mismo commit (hoy omite
  `script`/`rate`/`sample_rate`).
- **Criterio**: la config real del operador valida contra el schema.

### P0.3 Taxonomía: `config_write_failed` — S
- Alta del código en spec §CLI v1 + contrato §2.1 (la taxonomía sólo
  crece), destinado a fallos de escritura de config (P1).
- **Criterio**: el código existe documentado a más tardar en el commit
  que lo emita.

---

## P1 — Configuración por CLI (contrato config v1)

### P1.1 `config list` y `config get` — S
- `config list`: claves y valores (JSON); `config get <sección>` sobre
  lista cerrada (engines, constraints) — sin traversal (misma regla que
  `templates --show`).
- Enumeración cerrada en el MISMO commit: spec §CLI v1 y contrato §2.1
  ganan el grupo de comandos `config`.
- Tests con `GLOSOMATA_CONFIG` aislado.
- **Criterio**: un agente lee la config sin tocar el archivo.

### P1.2 `config set` atómico con validación completa — M — **ADV**
- `config set <archivo-json>`: replace atómico de la matriz completa
  (sin parches por clave). Flujo: leer nuevo → validar ESTRUCTURA
  (schema P0.2) → escribir temporal 0600 → `cargarMatriz` sobre el
  temporal (probes + kill_switch) → backup → `rename`. Si algo falla:
  `config_write_failed` o el código de causa; el original intacto.
- **Lo que se persiste es el contenido nuevo SIN campos derivados**
  (`available`, `causa` son anotaciones de runtime de `matriz.mjs`; los
  probes validan, no transforman).
- Backup: `$GLOSOMATA_RUNTIME/glosomata-<uid>/backups/` (mismo layout
  que canal), permisos 0600, retención por conteo: se conservan las
  últimas 5.
- Tests: set válido, set inválido (no muta), set sin kill_switch
  (rechazado), backup creado y podado, config sondeada no persiste
  campos derivados.
- **Criterio**: jamás queda una config rota en disco tras un `set`.

### P1.3 `config validate` — S
- Ejecuta la validación completa (estructura + probes + kill_switch)
  sobre el archivo real o `--file <ruta>`.
- **Criterio**: validar ANTES de escribir es un comando, no una fe.

---

## P2 — Configuración por MCP (sólo lectura, rutas curadas)

### P2.1 Tool `get_config` (saneada) — S — **ADV (frontera de divulgación)**
- Octava tool: devuelve la matriz **SANEADA igual que `engines`**
  (disponibilidad, no rutas del filesystem). La ronda 5 curó
  deliberadamente `list_engines` para no exponer `whisper_bin/model` al
  consumidor MCP (ops.mjs:99-100): esta decisión la RESPETA y NO la
  revierte — un agente MCP puede ser remoto.
- La configuración COMPLETA (con rutas) queda reservada al canal de
  loopback del operador (`GET /config` COMPLETA + `PUT /config`, P3):
  mismo nivel de confianza que editar el archivo a mano.
- Docs y tests en el MISMO commit: spec §MCP (8 tools), guía, contrato
  §1, conteo de tests 7→8, schema cerrado de la tool.
- **Criterio**: un agente MCP-only conoce disponibilidad y constraints
  sin ver una sola ruta del disco.

---

## P3 — `serve`: API HTTP de loopback

### P3.1 Servidor base + auth por token + timeouts por ruta — M — **ADV**
- `glosomata serve [--port N]` (default efímero): `node:http`, bind
  **127.0.0.1** únicamente; imprime por stdout una línea cerrada
  `{token, port, pid}` (token del CSPRNG del sistema).
- Auth: `Authorization: Bearer` obligatorio en TODO endpoint excepto
  `GET /health` (sólo `{ok, version}` — liveness sin datos) y los
  assets estáticos de la UI (excepción consciente: sin ellos la página
  no carga; sin cookies no hay credencial que robar). Check de `Host`
  (allowlist `127.0.0.1`/`localhost`) como defensa extra contra DNS
  rebinding: una página maliciosa del propio equipo no puede actuar
  sin token y no llega a nada útil sin él.
- **Timeouts por ruta** (el request-30s genérico estrangularía contratos
  vigentes): `/listen` = `timeout_s + 30s` de margen de transcripción
  (hasta ~150s); `/speak` tope 180s (kokoro en frío); `/selftest` tope
  300s; el resto 30s. Body límite 64 KB.
- **Shutdown desambiguado**: `stop` cross-process manda SIGINT al pid
  del lock — puede ser el pid del servidor. Por tanto: SIGINT durante
  operación = SOLO truncar (semántica de canal, no morir); shutdown
  real = SIGTERM, segunda SIGINT en <2s, o `POST /shutdown` con token.
- Errores de transporte ≠ taxonomía: HTTP 401/413/404/405/503 son
  estados de transporte; los códigos de taxonomía viajan en el payload
  de operación (igual que MCP). Puerto ocupado → exit 1 con razón en
  stderr (nivel transporte, como `stopped`).
- Enumeración cerrada en el MISMO commit: spec §CLI v1 gana `serve`
  (y el README §Comandos/§Estructura, cuya mención P0.1 sólo adelanta).
- Tests: token válido/inválido/ausente, bind loopback, body gigante,
  Host ajeno rechazado, SIGINT durante speak trunca sin morir,
  SIGTERM apaga, `POST /shutdown` con token apaga y sin token 401.
- **Criterio**: sin token no hay contenido; `glosomata stop` no mata al
  servidor; nada escucha fuera de loopback.

### P3.2 Endpoints de operación — M
- `GET /health`, `/version`, `/engines`, `/config` (COMPLETA, con
  rutas — canal del operador autenticado; la saneada es la tool MCP
  `get_config`, P2.1), `/templates` (CON `turns`, como MCP), `/doctor`;
  `POST /speak {text, engine?}`, `/listen {timeout_s?}`, `/stop`,
  `/session`, `/validate {session, text}`, `/shutdown` — todos delegan
  en `ops.mjs` (la MISMA capa que CLI/MCP: cero lógica duplicada).
  Cobertura completa del CLI: ningún comando sin endpoint o hueco
  declarado (`config validate` → `POST /config/validate`, P3.3).
- Semántica de errores: payload JSON `{error: <código>}` con la
  taxonomía cerrada (incluye `stopped` y `channel_busy`).
- Tests: cada endpoint ok + su error de taxonomía; dos `/speak`
  concurrentes → `channel_busy`; `/stop` corta un `/speak` en curso.
- **Criterio**: todo lo que hace el CLI por proceso existe por HTTP.

### P3.3 `PUT /config` — escritura completa del operador — S — **ADV**
- Replace atómico de la matriz completa con el MISMO validador y backup
  que `config set` (P1.2), sin campos derivados persistidos.
- **Con rutas reales** (a diferencia de `get_config` MCP): este canal es
  el navegador del propio operador con token — el mismo nivel de
  confianza que editar el archivo. Decisión explícita que delimita la
  curación de la ronda 5 (MCP sanea; loopback del operador no).
- `POST /config/validate`: valida un archivo sin escribirlo (P1.3 por
  HTTP).
- Tests de `/shutdown` con token (apaga) y sin token (401) aquí o en
  P3.1 — no queda sin test.
- **Criterio**: la web escribe config por aquí y jamás queda rota.

---

## P4 — Playground UI (vanilla, servida por `serve`)

### P4.1 Shell + pestaña Voz — M
- `src/ui/index.html` + JS vanilla, cero dependencias ni CDN; si el
  shell crece se parte por pestañas en archivos propios (gate 800
  líneas). Login por token en sessionStorage.
- Pestaña **Voz**: textarea → `/speak` (motor/voz elegible), paro →
  `/stop`, micrófono → `/listen` con cuenta regresiva visible (la UX
  comunica que la voz NO corta la captura — ventana fija).
- **Criterio**: probar voz desde el navegador sin tocar la terminal.

### P4.2 Motores, Config, Doctor, Ejemplos — M — **ADV (config)**
- **Motores**: matriz de `/engines` + doctor por motor (causas).
- **Config**: formulario generado desde el schema (P0.2), validación en
  cliente y guardado por `PUT /config` (replace completo); badge del
  backup creado.
- **Doctor**: causas legibles de `/doctor`.
- **Ejemplos**: recetas copiables CLI/MCP/HTTP por caso de uso.
- **Criterio**: configurar y verificar sin editar JSON a mano.

---

## P5 — Modo pruebas integrado

### P5.1 Self-tests desde el playground — M
- `POST /selftest` (token, tope 300s): suite ligera en vivo — probes de
  motores, eco mic→texto→voz con latencias, validate de plantillas —
  resultado JSON por ítem; la UI lo muestra como checklist.
- **Criterio**: «¿mi instalación funciona?» se responde desde el
  navegador en un clic.

---

## P6 — Roadmap de publicación (NO comprometido; exige ADR-009)

| Candidato | Condición previa |
|---|---|
| Multiusuario + auth | evidencia real de uso local sostenido |
| TLS / reverse proxy | decisión de despliegue del operador |
| Modo pruebas público | revisión de amenazas completa |
| Rate limits y cuotas | primera publicación real |

Fuera del alcance iterativo actual: este plan NO los ejecuta; reabrir
estos no-objetivos exige ADR-009 y decisión humana explícita.

---

## Orden y entregas

```
P0.1 → P0.3 → P0.2      (docs y esquema: la frontera queda escrita)
P1.1 → P1.3 → P1.2      (config por CLI)
P2.1                    (config por MCP, sólo lectura y saneada)
P3.1 → P3.2 → P3.3      (serve: API loopback)
P4.1 → P4.2             (playground UI)
P5.1                    (modo pruebas)
```

Cada tarea = un PR independiente. Si el plan se corta en cualquier
punto, lo entregado es estable y contractado. El servidor no existe
hasta P3: P0–P2 son puros CLI/MCP/docs.
