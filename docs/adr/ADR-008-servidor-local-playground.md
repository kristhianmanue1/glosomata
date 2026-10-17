# ADR-008: servidor local para playground de configuración y pruebas

Estado: PROPUESTA — pendiente de aceptación del humano (reabre un
no-objetivo v1 declarado)
Fecha: 2026-10-17
Numeración: 006 y 007 quedan reservados por el plan de consumo
(docs/plan-consumo-agentes-v1.md, tareas C3.1 y C3.3).

## Contexto

Los no-objetivos v1 (`docs/specs/specs-y-contratos-v1.md`) declaran
«sin servidor HTTP/socket». La configuración (`glosomata.json`) hoy se
edita a mano: sin schema formal, sin validación previa, sin copia de
seguridad, y fuera del alcance de agentes externos (los 7 tools MCP no
tocan config; el CLI tampoco). El operador pide: (1) gestionar la
configuración por comandos consumibles por agentes (CLI/MCP/API), y
(2) un playground web local para configurar, probar ejemplos y ejecutar
pruebas, con publicación externa segura como posibilidad futura.

## Decisión

1. **Se reabre el no-objetivo HTTP de forma acotada**: un servidor HTTP
   de loopback (`127.0.0.1` únicamente) para el playground local, sobre
   `node:http` (cero dependencias nuevas), con token de acceso impreso
   por stdout, timeouts, límite de cuerpo, y la política de logs intacta
   (sólo ids/códigos/duraciones). El kill-switch y el canal half-duplex
   se aplican idénticos que en CLI/MCP.
2. **La escritura de configuración pasa a ser gobernada**: schema JSON
   formal de `glosomata.json`, validación completa (estructura + probes)
   antes de guardar, escritura atómica (temporal 0600 + rename) y copia
   de seguridad previa fuera del árbol versionado.
3. **La publicación externa NO está incluida**: multiusuario, auth de
   usuarios, TLS y «modo pruebas público» siguen siendo no-objetivos y
   exigirán un ADR-009 futuro con decisión humana explícita. Este ADR
   autoriza exclusivamente el servidor local de loopback.

## Modelo de amenazas del loopback (explícito)

- **Adversario considerado**: otro proceso o página web del MISMO
  equipo. No hay red externa: bind en 127.0.0.1, nada escucha fuera.
- **Token Bearer** (CSPRNG, impreso por stdout) obligatorio en todo
  endpoint excepto `GET /health` (sólo `{ok, version}`: liveness sin
  datos) y los assets estáticos de la UI — excepción consciente: sin
  ellos la página no carga, y no contienen credenciales ni datos.
- **No hay cookies ni sesión**: un POST cross-origin desde una página
  maliciosa no lleva el token (header custom → preflight CORS
  bloqueado); DNS rebinding sólo alcanza `/health` y los assets. Check
  de `Host` con allowlist (`127.0.0.1`/`localhost`) como defensa extra.
- **Rutas del filesystem** (binarios, modelos): no se exponen por MCP
  (curación de ronda 5 intacta); por HTTP loopback sí viajan al
  navegador del operador autenticado — el mismo nivel de confianza que
  editar `glosomata.json` a mano.
- **El botón de paro es compartido** por diseño (contrato §5): `/stop`
  autenticado corta la operación de canal activa, sea de quien sea.

## Alternativas descartadas

- **CLI-only sin web** (TUI/editor): no resuelve el playground visual
  que pide el operador; la web local es la interfaz natural de pruebas
  de voz.
- **Framework web (Express/React)**: viola la regla de cero dependencias
  sin ADR que lo justifique; `node:http` + vanilla JS bastan para
  loopback.
- **Playground en proyecto aparte**: duplicaría la capa de operaciones
  (`ops.mjs`) o forzaría una superficie de librería que el contrato §1
  declara no contratada.
- **Reabrir multiusuario ya**: expandiría el modelo de amenazas sin
  necesidad demostrada; se delega a ADR-009 con evidencia real de uso.

## Consecuencias

- El playground hereda el modelo de amenazas local (un solo usuario,
  token contra procesos y páginas del mismo equipo — ver §Modelo de
  amenazas; no contra red externa).
- La taxonomía de errores crece con `config_write_failed`, documentada
  a más tardar en el commit que la emita (regla: sólo crece).
- El contrato de consumo §2.6 se actualiza en el commit que aterrice
  P0: «servidor HTTP de loopback para playground local, amparado por
  ADR-008; HTTP hacia redes externas sigue prohibido».
- Nuevas superficies (endpoints, tools) pasan por las rondas ADV del
  plan de playground antes de fusionarse.
