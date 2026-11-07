# PLAN: consumo local de LFM3-Omni desde glosomata

Estado: PROPUESTA documental, 2026-11-07. Encargo del Operador: guardar el
plan y registrar en `kristhianmanue1/LFM3-Omni-FK` las necesidades del
proveedor. Este documento no adopta un motor, cambia la matriz, inicia un
servicio ni autoriza implementación, commit, publicación o despliegue.

## Objetivo y frontera

Permitir que un consumidor coordine inferencia de LFM3-Omni con el canal
local de glosomata y, sólo tras un gate separado, evaluar LFM3 como motor
TTS opcional de `EngineTTS`. Glosomata conserva STT, TTS y contrato de
turnos; el agente consumidor decide la respuesta. LFM3 no entra al núcleo
como LLM ni sustituye a Piper por defecto (ADR-003 y ADR-010).

El alcance inicial es una máquina y loopback. El MCP remoto de LFM3 y el
servicio compartido v2 no son precondición del piloto local ni se infieren
activos por existir sus documentos. Audio y texto no se conservan en
glosomata más allá de la operación; cualquier retención del proveedor se
evalúa por ruta concreta antes de enviar datos reales.

## Base comprobada y límites

- Glosomata `main@1ab2d9c` reconoce `say`, `piper`, `kokoro` y
  `phonon_ollama` en `src/matriz.mjs`. `speak` permite hasta 2000 caracteres
  según su contrato y exige `kill_switch` en la matriz.
- LFM3 ofrece `infer_text` por MCP local y un gateway TTS en
  `POST /v1/audio/speech` (8092): entrada española de 1..600 caracteres,
  sin controles, WAV completo, una síntesis a la vez, 503 sin cola y
  timeout de síntesis de 120 s (SPEC-i1-vs).
- El gateway rechaza `voice` y `speed`; `mcp_server_v2.py` los acepta,
  no los transmite y devuelve el `voice` solicitado. Es una discrepancia
  de contrato que impide prometer selección de voz por MCP.
- En la observación del 2026-11-07, `8091/health` respondió `ok` y
  `8092` rechazó la conexión. La salud de 8091 no demuestra TTS listo.
- Los contratos de servicio compartido v2 de LFM3 están propuestos;
  los contratos locales v1 y MCP v2 tienen alcance distinto. Su árbol de
  trabajo tenía cambios ajenos en curso. Revalidar rama, diff, servicio
  y contratos antes de cualquier implementación.
- OpenCode v2.2.5 tiene un plugin global `timbre-jarvis.js`, cuya copia
  versionada está en `integrations/opencode/timbre-jarvis.js`, que al
  terminar una respuesta invoca `glosomata speak`. Tras la elección del
  Operador el 2026-11-07 pide `phonon-rebeca` con
  `glosomata.jarvis.json` separado; la matriz ordinaria conserva Piper.
  El probe y una locución directos pasaron, pero el hook de OpenCode no
  tiene prueba de turno extremo a extremo en este cambio. La
  configuración global usa `zai-coding-plan/glm-5.3-flash`; no registra
  LFM3 como MCP.
- La versión anterior del plugin escribió locuciones completas en
  `~/.config/opencode/timbre-jarvis.log`. El cambio dejó de añadirlas y
  restringió el log histórico a 0600, sin borrar su contenido. El texto
  aún pasa por `--text` en argv; el plugin descarta stdout, stderr y el
  código de salida de `speak`, y envía SIGTERM tras 120 s. Un cierre de
  sesión de OpenCode no acredita que el audio haya sonado completo.

Fuentes: `docs/specs/contrato-consumo-agentes-v1.md`,
`docs/specs/specs-y-contratos-v1.md`, `docs/adr/ADR-003-ollama-fuera-del-nucleo.md`
y `docs/adr/ADR-010-phonon-ollama-experimental.md` de glosomata;
`docs/contracts/mcp-tools-v2.md`, `docs/contracts/servicio-general-v2.md`,
`docs/specs/SPEC-i1-vs-sintesis-voz.md`, `src/mcp_server_v2.py` y
`src/gateway_core.py` de LFM3-Omni. La documentación acredita el contrato;
la ejecución futura debe acreditar la conducta.

## Entregas y gates

### G0 — Piloto en OpenCode, sin acoplar los núcleos

OpenCode ya obtiene una respuesta del agente y el plugin global la
reproduce con glosomata. Para evaluar LFM3 en esa ruta, registrar su
MCP local o un proveedor compatible en OpenCode y dirigirle un turno
de prueba; no registrar una segunda ruta de `speak` automático que
duplique el audio. LFM3 produce texto; el consumidor verifica estado,
completitud, límite y contenido apto para `speak`. La salida del modelo
es dato no confiable, no instrucción ni autorización. No se envían tool
calls del modelo a ejecución automática. El consumidor define reintento
acotado y degradación a texto si LFM3 o el canal no están disponibles.

La ruta actual de OpenCode es una base observada, no un gate aprobado:
el plugin pasa la locución por argv y conserva un log histórico con
contenido. Corregir o aislar esa exposición antes de enviar contenido
sensible o afirmar la política de no retención para el flujo completo. El MCP de
glosomata queda disponible para turnos controlados por el agente, pero
su uso simultáneo con el plugin exige una regla de un solo emisor.

**Gate G0:** prueba real de un turno con texto válido y casos que refuten
la ruta feliz: salida truncada, error del modelo, texto de más de 2000
caracteres, `channel_busy`, `stop` y servicio caído. Se comprueba que
ningún caso fallido se presenta como `played:true`, que hay una sola
locución por respuesta y que el flujo completo respeta la política de
custodia acordada. Este piloto exige encargo propio: el presente plan
no lo ejecuta.

### G1 — Contrato proveedor para TTS local

LFM3 debe publicar una interfaz estable para un consumidor TTS como
glosomata: versión/capabilities, endpoint y host fijados, prerequisitos
de arranque, voz realmente seleccionable o voz fija declarada, límites
de texto y WAV, errores estables, 503 ocupado, plazos, cancelación y
retención por ruta. Se cierra la discrepancia MCP `voice`/`speed` antes
de anunciar control de voz. Un test de consumidor representativo prueba
la interfaz publicada, no sólo el validador interno.

**Gate G1:** SPEC y contrato de LFM3 adoptados para la ruta local;
fixtures de error y WAV; pruebas del gateway y MCP con una voz distinta
de la predeterminada o rechazo explícito de ese parámetro; demo con
gateway vivo. Un `health` de 8091 por sí solo no pasa el gate.

### G2 — Decisión de adaptador opcional en glosomata

Si G1 pasa, decidir mediante ADR si se añade `lfm3_local` a `EngineTTS`.
La decisión fija: matriz aislada o adopción habitual; máximo efectivo de
600 caracteres o partición de texto con semántica de `echo` y
`truncated`; forma y límite de WAV; tiempo máximo; mapeo a la taxonomía
cerrada (`engine_unavailable`, `tts_failed`, `audio_device_error`);
prohibición de credenciales y rutas configurables hacia redes externas;
temporales 0600 y limpieza. No se inventan códigos de error.

El `kill_switch` debe cubrir solicitud y reproducción locales con una
latencia medida. Detener el cliente no prueba cancelación del trabajo en
el daemon de LFM3: el contrato declara el estado objetivo y qué ocurre
con una síntesis que termina tarde. El cerrojo global de glosomata y el
cerrojo TTS de LFM3 se prueban juntos; ninguno sustituye al otro.

**Gate G2:** ADR aceptado y SPEC/tests escritos antes del adaptador.
Sin decisión de límites, cancelación y custodia, el motor permanece
fuera de la matriz.

### G3 — Implementación y verificación, sólo con encargo posterior

Crear el adaptador mínimo y pruebas observables por proceso: probe de
capabilities, servicio ausente, 400, 503, 502, timeout, WAV inválido o
excesivo, texto límite, dos consumidores, `stop` durante solicitud y
reproducción, y limpieza tras fallo. Probar una síntesis y reproducción
reales con la versión y hardware fijados; medir latencia y recursos,
sin convertir la prueba local en promesa de calidad o disponibilidad.

**Gate G3:** `npm test`, `python3 scripts/check_sizes.py` con `OK`, diff
completo y ronda adversarial con contexto separado por interfaz a
consumidor no controlado y concurrencia. Veredicto `proceed`,
`fix-and-retry` o `escalate` no autoriza activar, publicar ni asumir
riesgos. Piper sigue seleccionado hasta una decisión distinta.

## Dependencias y seguimiento

1. Corregir o cerrar explícitamente `voice`/`speed` en el MCP local de
   LFM3: [issue #2](https://github.com/kristhianmanue1/LFM3-Omni-FK/issues/2).
2. Publicar contrato local de TTS y conformidad para consumidor externo,
   incluidos cancelación y custodia:
   [issue #3](https://github.com/kristhianmanue1/LFM3-Omni-FK/issues/3).
3. Resolver el texto en argv y la custodia del log histórico del plugin
   global de OpenCode antes de G0 con datos reales; la copia instalada
   está fuera de este repositorio.
4. Encargar G0 y, si procede, adoptar G2/G3 por separado en glosomata.

## Refutación y condición de parada

Un control positivo del gateway con WAV válido debe preceder a afirmar
que una sonda negativa prueba indisponibilidad. Si la respuesta MCP
atribuye una voz no aplicada, si `stop` deja audio después de informar
truncamiento, si los errores se confunden con éxito o si una llamada
conserva texto/audio fuera de la política acordada, detener la adopción
y registrar `fix-and-retry`. Una integración funcional no acredita
calidad de voz, licencia para un uso concreto, despliegue ni aceptación
institucional.
