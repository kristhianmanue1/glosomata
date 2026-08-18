# Flujo de voz y continuidad

## Modos de entrada

La persona puede escribir y usar **Enviar**, o iniciar un turno de voz con
**Hablar**. La entrada manual siempre está disponible y no activa continuidad
automática. La entrada por voz activa `voiceConversationActive`.

## Máquina de estados observable

```text
LISTO --Hablar--> ESCUCHANDO --resultado final--> CERRANDO_MICRÓFONO
  ▲                                        │
  │                                        ▼ onend
  │                              ESPERANDO_AGENTE
  │                                        │ respuesta
  │                                        ▼
  └--Terminar conversación-- HABLANDO_AGENTE
                                      │ onend y modo continuo
                                      └───────────────► ESCUCHANDO
```

Estados de error o degradación:

- Sin reconocimiento disponible: se desactiva **Hablar** y queda entrada
  manual.
- Sin resultado al cerrar el micrófono: el sistema no repite solo; pide pulsar
  **Hablar**.
- Fallo de reconocimiento: muestra el código del navegador y mantiene la
  alternativa manual.
- Fallo de síntesis: conserva la respuesta visible y ofrece **Escuchar
  respuesta**.
- Fallo del agente: muestra el error seguro del servidor, sin respuesta falsa.
- Reapertura automática bloqueada por el navegador: se informa que debe pulsar
  **Hablar**.

## Detección de fin de frase

`SpeechRecognition` o `webkitSpeechRecognition` genera un resultado final y
posteriormente el evento `onend`. El código conserva el texto final, espera
`onend` y sólo entonces llama a `sendMessage`. Por tanto, no se inicia la
respuesta del modelo mientras el reconocimiento sigue activo.

La detección concreta de silencio y fin de frase pertenece al navegador. El
prototipo no impone un temporizador de silencio ni intenta segmentar audio.

## Continuidad

Después de una entrada hablada, la respuesta del agente se reproduce mediante
`speechSynthesis`. Cuando su evento real `onend` ocurre, se intenta
`startListening(true)` para el turno siguiente. Si el navegador lo rechaza, la
interfaz cae a una acción explícita: **Hablar**.

La continuidad termina cuando ocurre cualquiera de estas acciones:

- la persona presiona **Terminar conversación**;
- la persona usa **Enviar** con texto manual;
- la página se descarga;
- se cancela o falla la síntesis sin una nueva acción de la persona.

## Invariantes de coordinación

1. El modelo recibe texto sólo después de que el reconocimiento terminó.
2. Un `speechTurnId` invalida callbacks `onend` de voces canceladas; una voz
   anterior no puede reabrir el micrófono después de **Terminar conversación**.
3. `stopSpeaking()` cancela la síntesis antes de iniciar reconocimiento.
4. La respuesta tiene espejo visual antes de que se intente hablarla.
5. Una ausencia de dictado no causa un bucle automático de escucha.
6. La voz no es la única vía: textarea y **Enviar** siguen disponibles.

## Prueba física requerida

La automatización no concede permisos de micrófono. Para validar el flujo
completo se debe probar, en cada navegador objetivo:

1. Pulsar **Hablar** y autorizar el micrófono.
2. Dictar una frase breve y confirmar que llega la respuesta.
3. Esperar que la voz termine y dictar una segunda frase sin tocar controles.
4. Pulsar **Terminar conversación** durante la locución y comprobar que no se
   abre el micrófono después.
5. Probar el fallback cuando el navegador exige pulsar **Hablar** otra vez.
