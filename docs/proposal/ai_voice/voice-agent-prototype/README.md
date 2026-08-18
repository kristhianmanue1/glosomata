# Voice Agent Prototype

Prototipo independiente para validar un turno de conversación por voz:

1. la persona habla o escribe;
2. el navegador obtiene el texto;
3. el servidor lo entrega a un adaptador de agente;
4. la respuesta aparece en pantalla;
5. el navegador la reproduce mediante síntesis de voz.

No forma parte de la aplicación clínica Alubia y no debe recibir datos
personales o de salud.

## Estado de esta versión

La configuración predeterminada está conectada al modelo local `qwen3:8b`
mediante Ollama. El navegador sólo conoce el contrato neutral
`POST /api/respond`; la arquitectura multimodelo completa queda para una
versión posterior.

También conserva `demo-agent`, un respondedor determinista sin inteligencia
artificial, para probar la interfaz cuando Ollama no esté disponible.

## Requisitos

- Node.js 20 o posterior.
- Para dictado: navegador con `SpeechRecognition` o
  `webkitSpeechRecognition`.
- Para voz de salida: navegador con `speechSynthesis`.
- Micrófono autorizado por la persona usuaria.

## Ejecutar

```bash
npm start
```

Confirme que Ollama esté activo y que `qwen3:8b` esté instalado. Abra
<http://localhost:8080>, presione **Hablar**, diga una frase y espere la
respuesta. Si el navegador no permite reproducirla automáticamente, presione
**Escuchar respuesta**. Siempre puede escribir y usar **Enviar**.

Al iniciar por voz, la página intenta abrir el siguiente turno de micrófono al
terminar de hablar el agente. **Terminar conversación** detiene esa continuidad.
Algunos navegadores exigen un toque nuevo para volver a habilitar el micrófono;
en ese caso se muestra el botón **Hablar** como alternativa.

## Probar

```bash
npm test
```

## Documentación para análisis

- [Arquitectura y contrato del sistema](docs/system-overview.md)
- [Flujo de voz, estados y continuidad](docs/voice-interaction.md)
- [Alcance, riesgos y preguntas abiertas](docs/analysis-scope.md)

## Cambiar modelo o usar el agente de demostración

Para elegir otro modelo instalado:

```bash
AGENT_PROVIDER=ollama OLLAMA_MODEL=<modelo-instalado> npm start
```

El servidor llama a Ollama en `http://127.0.0.1:11434` por defecto. Puede
cambiarse con `OLLAMA_BASE_URL`. No coloque tokens ni secretos en el navegador.

Para ejecutar sin un modelo de IA:

```bash
npm run start:demo
```

## Contrato actual

`POST /api/respond`

Entrada:

```json
{ "message": "Hola" }
```

Salida:

```json
{ "reply": "Hola. Le escucho.", "agent": "demo-agent" }
```

Un mensaje vacío, no textual o mayor a 2000 caracteres se rechaza. Los errores
del proveedor se muestran como fallo y nunca como una respuesta inventada.

## Límites conocidos

- El dictado depende de las capacidades y permisos del navegador.
- Safari puede exigir otro toque para iniciar la síntesis después de una
  respuesta de red; por eso existe el botón de repetición.
- La prueba automatizada no demuestra que el micrófono o el altavoz físicos
  funcionen en un dispositivo concreto.
- El modo alternativo `demo-agent` no es IA y la interfaz lo identifica.
- Esta versión no conserva conversaciones ni audio.
