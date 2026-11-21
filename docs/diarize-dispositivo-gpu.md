# Dispositivo de cómputo de la diarización (cpu / cuda / mps)

Petición del Operador (2026-11-21, vía tequio/Malintzin): la
diarización es la etapa que más consume; permitir computarla en GPU.
Configuración: `engines.diar.device` en la matriz (`cpu|cuda|mps`;
**default `cpu`** — sin la clave, nada cambia). Si el dispositivo
pedido no está disponible, el motor **vuelve a CPU sin caerse** y el
dispositivo EFECTIVO viaja en la respuesta (`"device"`): el aviso de
la vuelta atrás ES ese campo (el stderr del subprocess se drena por
política de logs; nunca lleva contenido).

## Equivalencia verificada (2026-11-21, Apple Silicon M2)

Con audio sintético de dos voces (17.3 s), `cpu` vs `mps`:
turnos **idénticos** y huellas con **coseno 1.000000** por hablante.
Tolerancia de referencia para comparar dispositivos: los turnos
deben coincidir y el coseno de huellas ≥ 0.999999 (en esta prueba
dio 1.0 exacto); diferencias mayores indican un problema, no
ruido. Latencia: **sin diferencia medible** en este host y modelo
(≈16.7 s ambos; el pipeline es pequeño y el M2 ya es rápido en
CPU) — el beneficio de GPU se espera en audio LARGO (horas) y en
CUDA. `cuda` no es verificable en este host (sin NVIDIA): se
verificó el CAMINO del fallback (pedir `cuda` aquí entrega
`"device": "cpu"`), no la inferencia CUDA misma.

## Despliegue en el Dell (RTX 2060, 6 GB) — guía para Malintzin

Linux nativo o WSL2, con venv por release y `--require-hashes`
(como pide la petición). PyTorch en Linux trae CUDA por defecto en
las wheels de su índice oficial; elige la variante CUDA del driver
del host:

```bash
# 1) driver NVIDIA presente y reporta la GPU
nvidia-smi

# 2) venv del release (aislado, como .venv-diar en el Mac)
python3.12 -m venv .venv-diar

# 3) instalar pyannote.audio con la variante CUDA de torch
#    (ejemplo con cu126; ajusta a la variante del driver:
#    https://pytorch.org/get-started/locally/)
.venv-diar/bin/pip install "torch==<versión-petición>" \
  --index-url https://download.pytorch.org/whl/cu126
.venv-diar/bin/pip install pyannote.audio

# 4) hashes reproducibles: congela y verifica. OJO: el índice de
#    PyTorch SÓLO trae wheels de torch; el resto vive en PyPI —
#    pip-compile necesita ambos índices
.venv-diar/bin/pip install pip-tools
```bash
# requirements-diar.in es TU lista de intenciones (una línea):
#   pyannote.audio
# y opcionalmente el pin de torch con la variante CUDA:
#   torch==<versión-petición> --index-url ...
# (el .txt con hashes lo genera pip-compile a partir de él)
.venv-diar/bin/pip-compile --generate-hashes \
  --index-url https://download.pytorch.org/whl/cu126 \
  --extra-index-url https://pypi.org/simple \
  -o requirements-diar.txt requirements-diar.in
.venv-diar/bin/pip install --require-hashes -r requirements-diar.txt

# 5) verifica CUDA disponible (antes de declarar device cuda).
#    «Disponible» es torch.cuda.is_available(); si la inferencia
#    FALLA en ejecución (p. ej. OOM con audio enorme), la operación
#    responde diar_failed/inferencia_fallida — disponible ≠ funciona
#    en todo input: el tope diar_max_duration_s sigue siendo tu red.
.venv-diar/bin/python -c "import torch; print(torch.cuda.is_available())"

# 6) espejo del pipeline (paso del Operador, igual que en el Mac)
#    y matriz con "device": "cuda"
```

Si el paso 5 dice `False`, deja `device` sin declarar (cpu): el
sistema sigue operativo y la respuesta lo evidencia. La VRAM de la
2060 (6 GB) es suficiente para community-1 (segmentation+embedding
son modelos pequeños); el batch interno es 32.

## Notas de frontera

- Las **huellas** no cambian en nada con el dispositivo (misma
  forma, misma `embedding_model`). Política de tequio (ADR-0005 D3):
  con dispositivo remoto NUNCA se piden `--embeddings` — es política
  del CONSUMIDOR; glosomata no la fuerza.
- El `device` de la matriz lo valida el schema (`cpu|cuda|mps`);
  un valor inválido en runtime degrada a `cpu` (default amable), y
  `config validate` lo rechaza como error de estructura.
- Todo sigue sin red: `HF_HUB_OFFLINE=1` y telemetría OFF fijos en
  el subprocess.
