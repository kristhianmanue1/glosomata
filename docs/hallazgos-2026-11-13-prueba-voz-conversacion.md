# Prueba de conversación por voz con el Operador (2026-11-13)

Un agente (Claude Code, Opus 5.5) conversó con el Operador desde su
propia sesión: `speak` para hablarle y `listen` para escucharlo. Las
frases citadas son del Operador (texto transcrito); no se guardó audio.

## Configuración validada

| Pieza | Valor |
|---|---|
| Voz | `--engine phonon-rebeca` (Rebeca, Ollama `phonon-es-mx-eval-20261027`), elegida por el Operador: «con Rebecca nos quedamos» |
| Escucha | `listen --timeout 120`: el tope es red de seguridad; corta 1.5 s de silencio tras la voz |
| Tono de turno | `Tink.aiff` antes de abrir el micrófono (`GLOSOMATA_TONO`) |
| Piso de ruido | percentil 10 de todo lo escuchado; umbral 2.5× piso + 150 |

## Hallazgos medidos

1. **El tono rompía el corte.** El Operador habla en cuanto suena el
   tono, y la calibración antigua (máximo de los primeros 300 ms) medía
   su voz: piso 1576 → umbral 4978, con una voz de pico 1576. `listen`
   llegaba al tope (33 s). Con el piso por percentil: 9 s.
2. **Voz del Operador baja frente al ruido.** Habla entre 600 y 1500 RMS;
   la sala en silencio da entre 130 y 980 (traza en `tests/stt.test.mjs`).
3. **Pausas.** Con 1 s de espera lo cortaba a media frase; con 1.5 s,
   una pausa normal llega completa. Una pausa larga deliberada sí corta.
4. **Tope.** 30 s cortó dos turnos largos (habla 30–45 s). Acordado: 120 s,
   el máximo del contrato. Cinco minutos se descartaron: con ruido que
   impida detectar el silencio se esperaría el tope entero, y whisper
   tarda más con audio largo.
5. **Música de fondo.** El ruido continuo impide el corte (turno de 53 s
   con `[Música]`). Pendiente: detector de voz real.

## Latencia y peso de los motores TTS (medido)

| Motor | Disco | Memoria | `speak` frase corta | Nota |
|---|---|---|---|---|
| `phonon-rebeca` | 123 MB (Ollama) | 143 MB residente | 5–7 s | Ollama la mantiene cargada unos minutos |
| `kokoro` / `kokoro-fem` | 372 MB + `.venv` 1.2 GB (torch, mlx) | por llamada | 9–15 s | se recarga en cada frase: 1.4 s de carga + 6.2 s de calentamiento; caliente sintetiza en ~1.4 s |
| `piper-claude` | 60 MB | por llamada | no medido | el más ligero con modelo |
| `say` | 0 (sistema) | — | no medido | voz del sistema |

## No probado

- Latencia de `piper-claude` y `say` en esta sesión.
- Respaldo SIGINT del corte (ffmpeg cerró siempre con `q`).
- Un motor kokoro residente (requiere ADR: hoy es un proceso por llamada).
