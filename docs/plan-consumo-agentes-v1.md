# Plan de consumo para agentes — v1

> **Estado:** PROPUESTA en ejecución. C0 y C1 cerrados (2026-10-17,
> PRs #6–#13); C2 implementado y verificado en 2026-10-27 según los
> criterios afinados por el operador: `busy_pid` sólo diagnóstico y
> causas de audio sólo cuando la evidencia permite atribuirlas.
> Ejecución sólo con aceptación del humano, tarea por
> tarea. Complementa `docs/specs/contrato-consumo-agentes-v1.md`
> (el contrato que este plan hace real) y sigue el estándar de
> `docs/estandar-diseno-software-github.md`.

## Reglas de ejecución (aplican a toda tarea)

1. Una rama por tarea (`feat/session-new-mcp`), commit atómico, suite
   verde y `check_sizes.py` OK antes de declarar hecha.
2. Test que reproduce primero para todo bug; test nuevo para toda
   conducta nueva. Sin mocks del motor donde el contrato es observable
   por proceso (convención del repo).
3. Ronda adversarial (subagente fresco) para tareas marcadas **ADV**:
   tocan frontera de validación, concurrencia o parsing de config.
4. Push, merge y tags: autorización humana una por una. Cada incremento
   termina en algo usable aunque el siguiente nunca llegue.
5. Docs y taxonomía se actualizan en el MISMO commit que la conducta.

Leyenda de tamaño: S ≤ media sesión; M ≤ una sesión; L requiere partirse.

---

## C0 — Adopción verificable (entrega: consumidor nuevo se instala sin leer código)

### C0.1 `version` + fuente única de versión — S
- `src/cli-core.mjs`: comando `version` → `{name, version}` leído de
  `package.json` (import JSON con `with { type:'json' }` — el atributo
  `assert` lanza SyntaxError en Node ≥22 — o lectura con `readFile`;
  sin hardcode).
- `src/mcp-core.mjs`: `serverInfo.version` desde el mismo origen (muere
  el riesgo de drift; hoy coinciden por accidente).
- Tests: CLI imprime versión igual a `package.json`; `initialize`
  devuelve la misma.
- **Criterio**: dos fuentes de verdad → una.

### C0.2 `doctor` — M — **ADV**
- Comando nuevo (CLI): `glosomata doctor` → JSON con checks cerrados:
  node ≥20; config legible (o `config_unreadable` con causa); por motor
  TTS: disponible + causa si no; STT: whisper_bin/model existen; ffmpeg
  presente por plataforma (respetando `GLOSOMATA_FFMPEG`).
- Exit 0 si todo disponible, 1 con detalle si no. Reusa probes de
  `matriz.mjs`/`ops.mjs`; sin duplicar lógica de probe.
- Tests con `GLOSOMATA_CONFIG` aislado: config rota, motor sin
  kill_switch, whisper ausente. Sin micrófono ni motores reales.
- **Criterio**: un consumidor distingue "no instalado" de "no
  disponible" sin abrir código (motivación: contrato de consumo §7).

### C0.3 Documentar variables contractuales — S
- `docs/guia-mcp.md` + `README.md`: `GLOSOMATA_CONFIG`,
  `GLOSOMATA_RUNTIME`, `GLOSOMATA_FFMPEG` (hoy sólo la primera está
  documentada; las otras dos viven en comentarios de código).
- **Criterio**: toda variable de entorno leída por `src/` aparece en la
  guía (grep bidireccional como verificación).

---

## C1 — Agente MCP-only de primera clase (entrega: turno completo sin tocar CLI)

### C1.1 Tool `session_new` — S
- `src/mcp-core.mjs`: séptima tool `session_new(template_id?)` →
  `sesion.mjs:sessionData` reutilizado (no duplicar acuñación); TTL y
  catálogo idénticos al CLI.
- `inputSchema` cerrado: `template_id` opcional string.
- Docs a actualizar en el MISMO commit (enumeraciones cerradas):
  `docs/specs/specs-y-contratos-v1.md` §MCP (lista cerrada de tools),
  `docs/guia-mcp.md` §Tools, y el conteo del §1 del contrato de
  consumo.
- Tests: sin template → sesión `template:null`; id builtin → turn 0;
  id desconocido → `not_found`.
- **Criterio**: la guía §Flujo deja de requerir CLI en el paso 1.

### C1.2 `list_templates` con `turns` — S
- `src/mcp-core.mjs`: pasar `--show`-equivalente o exponer catálogo
  completo (decisión: lista completa con `turns`; el pattern ya se
  divulga en `validate` fail → `expected`, sin nueva superficie).
- Tests: `list_templates` incluye `turns` de `confirmar`.
- **Criterio**: un agente MCP-only sabe qué espera cada plantilla antes
  de validar.

### C1.3 Verificación de forma de sesión — S — **ADV**
- Estado real: template y turn SÍ se validan hoy (`template_invalid` /
  `session_invalid`); NO se verifican el campo `schema`, la forma de
  `ttl_min` ni la forma del objeto en la ruta CLI.
- `sesion.mjs` / `plantillas.mjs` (validate CLI + MCP):
  1. guardia de forma: sesión que no es objeto plano →
     `session_invalid` (hoy JSON `null` vía CLI lanza `TypeError` crudo
     fuera de taxonomía);
  2. `schema !== 'glosomata/sesion-v1'` → `session_invalid`
     (`acunar()` escribió `schema` desde el commit inicial `b837277`:
     sin sesiones legítimas rotas);
  3. `ttl_min` no numérico o negativo → fail-closed (antes comparaba
     contra `NaN` y la sesión nunca expiraba).
- Compat: documentar en CHANGELOG; sin sesiones legítimas afectadas.
- Tests: sin schema → `session_invalid`; `ttl_min` malformado →
  fail-closed; JSON `null` → `session_invalid` sin `TypeError`; schema
  correcto → fluye.
- **Criterio**: lo que el spec llama sesión es lo único que validate
  acepta, y ninguna entrada produce código fuera de taxonomía.

### C1.4 Negociación de `protocolVersion` — S
- `src/mcp-core.mjs`: `initialize` responde la versión pedida por el
  cliente si es soportada (`2024-11-05` hoy); si no, la máxima
  soportada. `SUPPORTED = ['2024-11-05']` como lista, no string suelto.
- Tests: cliente pide `2024-11-05` → eco; cliente pide `1999-01-01` →
  `2024-11-05`.
- **Criterio**: negociación honesta, lista para clientes MCP futuros.

### C1.5 Sesión libre (`template:null`) validable — S — **ADV**
- Bug preexistente detectado en ronda adversarial: `session new` sin
  `--template` acuña `template:null` y `validate` sobre ella responde
  `template_invalid`, contradiciendo SPEC-2 ("sesión libre → ok
  siempre"). C1.1 ampliaría este hueco a los agentes MCP-only.
- `plantillas.mjs:validarTurno`: plantilla `null` → semántica free
  (`{result:'ok', next_turn: turn+1}` tras validar turn). Alternativa
  descartada: acuñar `CATALOGO.libre` en su lugar (dejaría rotas las
  sesiones `null` ya acuñadas y cambiaría la forma del campo
  `template` en las nuevas; glosomata jamás muta sesiones existentes,
  ADR-001).
- Tests: `session new` (sin template) + validate → ok; turn basura
  sigue → `session_invalid`.
- **Criterio**: el caso SPEC-2 "sesión libre → ok siempre" pasa con la
  sesión que el CLI acuña por defecto.

---

## C2 — Contención y observabilidad para varios agentes (entrega: cooperación sin leer fuente)

### C2.1 `channel_busy` informado — S — **ADV**
- `src/canal.mjs`: al fallar adquisición, adjuntar `{busy_pid}` cuando
  el lock conserva un PID vivo. `ops`/`stt` lo propagan en `data`.
- Documentar en contrato §5: `busy_pid` es un snapshot diagnóstico,
  no estima duración ni gobierna el backoff; reintento es política del
  agente, sin cola en v1.
- Tests: dos adquisiciones → la segunda ve el PID registrado en el lock.
- **Criterio**: cuando se informa, el agente recibe ese PID como pista
  diagnóstica, sin inferir identidad actual, cuánto esperar ni usarlo
  para interrumpir.

### C2.2 `duration_ms` en resultados — S
- `speak`/`listen` añaden `duration_ms` entero no negativo (medición
  wall-clock desde la entrada hasta después de limpiar), también en
  fallos e interrupciones. La política de logs ya admite duraciones;
  es dato, no log.
- Tests: campo presente y entero ≥0.
- **Criterio**: el orquestador mide latencia por motor sin tocar nada.

### C2.3 Causas cerradas de audio — M — **ADV**
- Conjunto cerrado de causas estructuradas (`causa` de lista fija):
  `permission`, `device_missing`, `ffmpeg_missing`, `capture_failed`,
  `playback_failed`, `whisper_failed`.
- Estado anterior que corrige: `mic_denied` agrupaba permiso,
  dispositivo y fallo de captura (exit≠0 de ffmpeg); en TTS las causas
  de afplay (piper/kokoro) quedaban en `Error.cause` y `speakCore` las
  descartaba al armar `data`.
- Alcance: clasificar en `ops.speakCore` los errores de reproducción de
  los adaptadores como `playback_failed`; no reenviar `Error.cause`
  crudo al consumidor.
- Un exit genérico de ffmpeg, WAV ausente o ilegible se informa como
  `capture_failed`: no acredita `permission` ni `device_missing`.
  Estas dos causas quedan reservadas hasta contar con sonda fiable.
- Compat: campo nuevo → compatible por contrato §2.2.
- Tests de captura y whisper con binarios simulados (paths por env, ya
  existe el patrón `GLOSOMATA_FFMPEG`); clasificación TTS probada a
  nivel de función. La reproducción fallida de `speak` no tiene prueba
  de proceso extremo a extremo en esta entrega.
- **Criterio afinado**: el consumidor distingue captura, reproducción y
  whisper fallidos; no recibe un diagnóstico falso de permiso o
  dispositivo cuando la sonda sólo prueba fallo de captura.

### C2.4 Guía de reintentos y degradación — S
- `docs/guia-mcp.md`: sección "Operación multiagente": backoff ante
  `channel_busy` (incluida la limitación de pid reciclado,
  `SECURITY.md`), cuándo usar `stop`, cuándo degradar a texto (el
  humano lee), límites de `timeout_s`.
- **Criterio**: la política de espera vive en docs, no en folklore.

### C2.5 Codificación única de errores MCP — S — **ADV**
- `mcp-core.mjs`: los errores que antes escapaban pelados por `.catch`
  (`config_unreadable`, códigos imprevistos) se normalizan a la forma
  JSON `{"error":"<código>"}`. El contrato §4 declara la codificación
  dual vigente hasta que esta tarea cierre; entonces pasa a única.
- Compat: cambia el payload de los casos que el contrato §4 declara
  hoy en forma pelada; no rompe a quien implementa el fallback de §4
  (aceptar ambas formas). Anotar en CHANGELOG y en el contrato.
- Tests: `tools/call` con `GLOSOMATA_CONFIG` roto → JSON parseable con
  `error:"config_unreadable"`.
- **Criterio**: `JSON.parse(content[0].text)` nunca revienta.

---

## C3 — Plantillas del orquestador y decisiones de frontera (entrega: "crea la propia" sin JSON a mano)

### C3.1 ADR-006: superficie de plantillas propias — S
- Decisión documentada: archivo de plantillas declarado en
  `glosomata.json` (clave `templates`, ruta) o `GLOSOMATA_TEMPLATES`;
  validación con `validarPlantilla` (sin gramática nueva); ids propios
  no pueden pisar `builtin` (conflicto → `template_invalid`, ver C3.2).
- Alternativas descartadas escritas (plantillas en línea en config,
  directorio de scan).

### C3.2 Implementar carga de plantillas propias — M — **ADV**
- `matriz.mjs` carga y valida al leer config (fail-closed en arranque
  de operación, igual que probes); `templatesOp`/`list_templates` y
  `session new --template` ven el merge builtin+propias.
- Taxonomía: plantilla propia inválida o id que pisa un builtin →
  `template_invalid` (el validador nativo ya lo produce);
  `config_unreadable` queda reservado a config ilegible o sin
  estructura. ADR-006 ratifica el mapeo.
- Tests: propia válida aparece; inválida → `template_invalid`; id
  duplicado con builtin → `template_invalid`; builtin intocable.
- **Criterio**: un orquestador define su contrato de turnos sin tocar
  `src/`.

### C3.3 ADR-007: superficie de librería Node — S
- El contrato de consumo §1 YA declara S3 no contratada; el ADR la
  ratifica como decisión con alternativas descartadas (exportar
  `ops.mjs` con semver vs consumo por CLI/MCP), para que no se deduzca
  de un import accidental.
- Recomendación: seguir interna en v1 (el contrato ya cubre los dos
  perfiles reales); reabrir sólo con un consumidor Node real.

---

## C4 — Candidatos v2 (no comprometidos; cada uno exige ADR + autorización)

| Candidato | Gatillo | Nota |
|---|---|---|
| Daemon TTS (kokoro en caliente) | medición de arranque en frío reproducible (hallazgo #2) | kill-switch y ciclo de vida en el ADR |
| VAD/barge-in v1.1 | dolor real de UX en turnos largos | ADR propio ya anunciado en no-objetivos |
| Cola/prioridad de turnos (REQ-12) | ≥3 agentes concurrentes reales | reemplaza la política de backoff del consumidor |
| Idioma STT seleccionable | primer consumidor no-español | `-l es` hoy fijo en `stt.mjs` |
| RMS de silencio configurable | falsos `mic_timeout` en entorno ruidoso | umbral 120 hoy fijo |

---

## Orden y entregas

```
C0.1 → C0.3 → C0.2           (semana 1: adoptabilidad)
C1.1 → C1.2 → C1.5 → C1.3 → C1.4   (semana 2: MCP-only completo)
C2.1 → C2.2 → C2.4 → C2.3 → C2.5   (semana 3: multiagente)
C3.1 → C3.3 → C3.2           (semana 4: orquestador define turnos)
```

Cada tarea = un PR/commit independiente y usable. Si el plan se corta en
cualquier punto, lo entregado hasta ahí es estable y contractado.
