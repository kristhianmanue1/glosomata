# ADR-003: Ollama fuera del núcleo

Estado: aceptado
Fecha: 2026-08-18
Fase: F1

## Contexto

Decisión humana 2026-08-18: Ollama es de prueba. El sistema es CLI y MCP
para cualquier cliente de IA.

## Decisión

glosomata es canal puro: STT, TTS y contrato de comunicación. El LLM vive
en el agente consumidor. Ollama queda como demo en los prototipos web de
`docs/proposal/`, que no son parte del sistema.

## Alternativas descartadas

- Mantener el adaptador Ollama en el núcleo (como los prototipos):
  convierte el canal en chatbot y acopla el despliegue a inferencia local.

## Consecuencias

- `expectation: intent-free` queda excluida de v1: juzgar intención
  requiere semántica que el núcleo no tiene. Plantilla que la usa →
  `not_supported` (schema válido, feature excluida).
- `speak` no genera respuesta: sólo reproduce el texto que el agente decide.
