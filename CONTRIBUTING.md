# Contribuir

Proyecto local-first con cero dependencias npm. Antes de abrir un PR:

1. **Gates en verde**, con evidencia en el PR:
   ```bash
   npm test                       # suite node --test
   python3 scripts/check_sizes.py # estructura y límites de tamaño
   ```
2. **Reglas del repo** (detalladas en `AGENTS.md`):
   - No añadir dependencias npm sin un ADR que lo justifique.
   - Errores sólo con códigos de la taxonomía cerrada
     (`docs/specs/specs-y-contratos-v1.md`); nada de códigos inventados.
   - Fail-closed: ante incertidumbre, estado de fallo explícito.
   - Logs sólo ids, códigos y duraciones; JAMÁS texto, patrón,
     transcripción ni echo. MCP loguea a stderr, nunca stdout.
   - No persistir audio, texto ni transcripciones más allá del proceso.
3. **Cambios materiales** (persistencia, consumo de salida de LLM,
   concurrencia, nuevas interfaces) requieren ronda de revisión
   adversarial — describe en el PR cómo se hizo.
4. **Motores TTS nuevos**: sólo con contrato `EngineTTS` + kill_switch
   declarado en la matriz (ADR-002). Piper siempre subprocess, texto por
   stdin, prohibido link y bundle (ADR-005).
5. **Formato**: ESM (`.mjs`), español en comentarios y docs, inglés en
   identificadores. Decisiones de diseño que cambien contratos → ADR
   nuevo en `docs/adr/`.

Flujo: rama desde `main` (`trabajo/<tema>`), PR con evidencia de gates,
revisión antes del merge. `main` siempre compilable y testeada; los
releases se etiquetan desde ella.
