# Alcance de análisis

## Hechos verificados

- El servidor sirve la interfaz local y atiende `POST /api/respond`.
- La selección por defecto es `ollama:qwen3:8b`.
- El adaptador valida la respuesta y limita la espera a 45 segundos.
- La interfaz admite texto, dictado, síntesis y continuidad posterior a una
  entrada hablada.
- `npm test` cubre validación, selección de proveedor, respuesta Ollama
  simulada, servicio de la página, contrato HTTP y error de agente.
- Se validaron dos mensajes manuales consecutivos contra Ollama local antes de
  documentar esta versión.

## Fuera de alcance actual

- Multiproveedor completo, selección dinámica de modelos y herramientas.
- Memoria conversacional, historial o persistencia de sesiones.
- Streaming de tokens o audio.
- Autenticación, cuentas, despliegue público o acceso desde otra red.
- Moderación de contenido, evaluación de calidad del modelo o guardrails por
  dominio.
- Soporte garantizado de Safari, Android o aplicaciones instaladas.
- Datos personales, clínicos, biométricos o de menores.

## Riesgos a evaluar antes de ampliar

| Riesgo | Estado actual | Acción requerida |
|---|---|---|
| Permisos y compatibilidad de voz | Dependiente del navegador. | Pruebas físicas en Safari, Chrome Android y escritorio objetivo. |
| Latencia del modelo | `qwen3:8b` puede tardar varios segundos. | Medir p50/p95, mensaje de espera y criterio de timeout. |
| Alucinaciones | El modelo puede responder erróneamente. | Definir propósito, instrucciones de sistema, guardrails y revisión humana. |
| Datos sensibles | No se deben introducir. | Definir clasificación, consentimiento, retención y frontera de red antes de admitirlos. |
| Interrupción de turno | `Terminar conversación` controla la UI, no cancela una inferencia ya enviada. | Diseñar cancelación extremo a extremo si el producto lo necesita. |
| Multi-modelo | Sólo hay demo y Ollama. | Especificar contrato de adaptador, capacidades y matriz de errores. |

## Preguntas abiertas

1. ¿Cuál es el propósito concreto del agente y qué temas debe rechazar?
2. ¿Debe recordar turnos previos durante una sesión? Si sí, ¿dónde se conserva
   y cuánto tiempo?
3. ¿Qué navegadores y dispositivos son requisitos de lanzamiento?
4. ¿Qué latencia máxima es aceptable antes de ofrecer reintento o fallback?
5. ¿Qué modelos y proveedores entrarán en la versión multimodelo?
6. ¿Se requerirá conversación por voz sin conexión?
7. ¿El sistema podrá usar herramientas externas, consultar documentos o tomar
   acciones? Cada frontera requiere autorización y controles propios.

## Criterios para la siguiente fase

Antes de considerar el prototipo como base de un producto, cerrar al menos:

- propósito y no objetivos del agente;
- política de datos y red;
- navegación/compatibilidad objetivo;
- contrato versionado del adaptador multimodelo;
- pruebas físicas de voz;
- estrategia de fallos, cancelación y observabilidad;
- evaluación de calidad y seguridad específica del dominio.
