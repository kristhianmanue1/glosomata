# Plan: prueba local de Whisper y Kokoro

## Propósito

Construir un segundo prototipo, aislado de `voice-agent-prototype`, que pruebe
una conversación de voz completamente local en una Mac Apple Silicon M2:

```text
micrófono -> Whisper.cpp -> Ollama -> Kokoro -> altavoz
```

La prueba compara la comprensión y latencia de la entrada local con la voz de
salida Kokoro. No sustituye la versión actual ni modifica sus dependencias,
rutas, configuración o voz de navegador.

## Límites de alcance

- Directorio nuevo propuesto: `voice-agent-local-audio-prototype`.
- Conservación íntegra: `voice-agent-prototype` sigue funcionando con
  `speechSynthesis` y dictado del navegador.
- Agente inicial: el mismo contrato local de Ollama (`qwen3:8b`).
- Idioma de prueba: español; Whisper multilingüe, nunca una variante `.en`.
- No guardar audio, transcripciones ni conversaciones.
- No procesar datos personales, clínicos ni de salud.
- No incorporar clonación de voz, llamadas de red para TTS ni proveedores de
  pago en esta iteración.

## Decisiones técnicas iniciales

| Componente | Decisión | Razón |
| --- | --- | --- |
| STT | `whisper.cpp`, modelo `small` multilingüe | Buen equilibrio de reconocimiento en español y recursos para M2. |
| Aceleración STT | Metal por defecto; evaluar Core ML/ANE después | Menor complejidad en el primer arranque y ruta de mejora definida. |
| LLM | Ollama local, adaptador existente | Conserva el límite multimodelo: el agente no depende de la voz. |
| TTS | Kokoro local, voz `ef_dora` | Modelo abierto, salida local y buena referencia de naturalidad. |
| Transporte | Servicios locales en `127.0.0.1`, HTTP | El navegador no recibe claves ni habla con servicios externos. |
| UI | Página web local | Permite micrófono, reproducción y prueba manual en Safari/Chrome. |

`ef_dora` es español general, no español mexicano. Piper `es_MX-ald-medium`
queda como comparador posterior, no como parte de la primera implementación.

## Arquitectura y contratos

El navegador captura audio sólo tras un gesto explícito. Lo envía al adaptador
STT local, que entrega texto a `POST /api/respond`; la respuesta textual se
muestra siempre y se entrega al adaptador TTS. Éste devuelve audio reproducible
por la página.

```text
Browser --audio--> POST /api/transcribe --text--> POST /api/respond
Browser <--audio-- POST /api/synthesize <--reply-- adaptador Ollama
```

Contratos mínimos propuestos:

```json
POST /api/transcribe  { "audio": "multipart/form-data" }
                         -> { "text": "...", "language": "es" }
POST /api/respond     { "message": "..." }
                         -> { "reply": "...", "agent": "ollama" }
POST /api/synthesize  { "text": "...", "voice": "ef_dora" }
                         -> audio/wav
```

Los límites de duración, tamaño, timeout, tipos MIME aceptados y respuesta de
cancelación se definirán antes de implementar cada endpoint. El servidor
rechazará entradas no válidas y no retendrá archivos temporales tras terminar
la solicitud.

## Plan de ejecución

1. Crear el directorio paralelo y copiar sólo patrones necesarios, sin enlazar
   ni editar la versión actual.
2. Añadir configuración validada: rutas de binarios/modelos, modelo Whisper,
   voz Kokoro, URLs sólo de loopback y timeouts. Ningún secreto.
3. Integrar Whisper.cpp con un modelo `small` multilingüe y una prueba de
   transcripción de fixture en español. No activar Core ML todavía.
4. Integrar un servidor Kokoro local compatible con M2/MLX, generar WAV y
   probar que la salida no esté vacía ni sea de tipo inesperado.
5. Implementar adaptadores HTTP, controles de iniciar/cancelar y estados de
   interfaz. La respuesta escrita debe funcionar aunque STT/TTS fallen.
6. Añadir pruebas unitarias de validación, timeouts, errores de proveedor y
   limpieza de temporales; una prueba integrada con dobles, nunca con el
   micrófono físico.
7. Ejecutar prueba física en M2: Safari y Chrome, permiso de micrófono,
   interrupción, dos turnos consecutivos, acento mexicano y ruido moderado.
8. Medir y documentar: tiempo hasta texto, tiempo hasta primer audio,
   comprensión percibida y uso de memoria. Comparar contra Piper y voz del
   navegador antes de cualquier sustitución.

## Criterios de aceptación de la prueba

- La aplicación actual no presenta cambios de contenido ni de comportamiento.
- El nuevo prototipo inicia sin red salvo Ollama en `127.0.0.1` y descargas
  iniciales explícitas de los modelos.
- Una frase en español se transcribe, obtiene respuesta de Ollama y se oye una
  respuesta Kokoro; el texto permanece visible.
- Cancelar durante captura o reproducción no inicia un turno posterior ni deja
  micrófono/audio activo.
- Si Whisper, Kokoro u Ollama no están disponibles, la UI explica cuál falta y
  conserva entrada manual cuando sea posible.
- Las pruebas automatizadas pasan y la validación física se registra por
  navegador y equipo.

## Riesgos y paradas

- **Licencias:** verificar licencia exacta de motor, pesos y voz antes de
  distribuir; no asumir que una licencia de código cubre una voz.
- **Latencia:** si `small` no permite turnos fluidos, medir `base` y Core ML
  antes de cambiar de arquitectura.
- **Calidad regional:** no afirmar español mexicano para `ef_dora`; evaluar
  Piper `es_MX` por separado.
- **Privacidad:** detener el despliegue si algún adaptador envía audio o texto
  fuera de loopback sin una decisión y autorización explícita.
- **Compatibilidad:** detener y reportar si Safari no permite la captura o
  reproducción requerida; no degradar silenciosamente sin interfaz manual.

## Ronda adversarial al cierre

La revisión final se limita a: aislamiento entre prototipos, exposición de
datos/audio, cancelación y recursos temporales, rutas/secretos, compatibilidad
Safari en M2 y evidencia de las pruebas. Hallazgos materiales se corrigen y se
repite sólo el frente afectado.
