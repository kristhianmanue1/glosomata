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

Con audio sintético de dos voces (17.3 s y 29 s), `cpu` vs `mps`:
turnos **idénticos** y huellas con **coseno 1.000000** por hablante.
Con audio de 29 s: **mps 8,3 s vs cpu 20,0 s (≈2,4×)** — la ventaja
aparece con audio largo; en clips cortos no se mide. Latencias =
observaciones de este host, nunca cotas. `cuda` no es verificable
en este host (sin NVIDIA): se verificó el CAMINO del fallback
(pedir `cuda` aquí entrega `"device": "cpu"`), no la inferencia
CUDA misma.

**Ruido de librerías en stdout (hallazgo B1, ronda r3):** el
clustering VBx emite warnings («Value of auxiliary function has
decreased!», observado en mps) por la vía del stdout — un `print`
de Python (vbx.py) y, potencialmente, salida con búfer de libc —
corrompiendo el JSON. El script pone fd 1→fd 2 en cuarentena
durante carga+inferencia, hace `fflush` de libc DENTRO de la
cuarentena (H1 r4: cubre búferes C que se volcarían tras el JSON) y
emite el JSON por el fd 1 original: el protocolo queda limpio tanto
para `print`s como para salida nativa con búfer (todo va al stderr
que glosomata drena por política de logs). Residual declarado: sin
test hermético de la cuarentena (vive en el script Python y sólo
se ejercita con el motor real — verificado en r4 con el warning
provocado; H3 r4).

## Despliegue en el Dell (RTX 2060, 6 GB) — guía para Malintzin

Linux nativo o WSL2, con venv por release y `--require-hashes`
(como pide la petición). Desde el 2026-11-21 el camino canónico es
el lock del repo (sección «Lock del despliegue», abajo); esta receta
manual queda como referencia. PyTorch en Linux trae CUDA por defecto
en las wheels de su índice oficial; elige la variante CUDA del driver
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

## Lock del despliegue (R-1, 2026-11-21)

El repo ya publica el lock con hashes para el Dell:
`requirements/diar-linux-cuda.lock` — 113 ruedas manylinux x86_64
(cp312/abi3/py3-none), `torch==2.15.0` (build CUDA 13.2 de PyPI) y
`pyannote-audio==4.0.7` con las 93 versiones EXACTAS del
`.venv-diar` del Mac: paridad con el host donde se verificó la
equivalencia. Sustituye los pasos 3–4 de la receta de arriba (elegir
variante y congelar hashes a mano): ya está elegido y congelado.

```bash
python3.12 -m venv .venv-diar
.venv-diar/bin/pip install --require-hashes \
    -r requirements/diar-linux-cuda.lock
.venv-diar/bin/python -c "import torch; print(torch.cuda.is_available())"
```

### Compatibilidad CUDA 13 con el driver del Dell (análisis documental)

La petición pedía «CUDA compatible con el driver 621.14 (CUDA 12.x)»,
pero el lock resuelve `torch==2.15.0` de PyPI: build CUDA 13.2 que
arrastra la pila `nvidia-*` de CUDA 13 (`cudnn-cu13`, `nccl-cu13`,
`nvshmem-cu13`, `cublas 13.4`…). Análisis por documentación NVIDIA
(2026-11-21, sin descargar ni instalar nada):

- **CUDA 13.x exige driver >= 580.** Las Release Notes del Toolkit
  fijan, para compatibilidad de versión menor, 13.x: >= 580 y 12.x:
  >= 525 (< 580) — «Existing CUDA 13.x applications run on drivers
  >=580 under CUDA minor version compatibility». Ramas por toolkit:
  13.0→R580 … 13.2→R595 … 13.5→R620.
- **El driver del Dell cumple con holgura.** 621.14 (lectura de la
  petición) o KMD 621.24 con CUDA UMD 13.5 (lectura de Malintzin,
  inventario del 2026-11-21): 621 > 620 = rama de CUDA 13.5, muy por
  encima del mínimo 580. El driver es retrocompatible
  («applications compiled against a particular CUDA Toolkit version
  continue to work on subsequent driver releases»): también
  ejecutaría builds CUDA 12.x — la vuelta atrás que pedía la petición
  NO es necesaria.
- **Turing sigue soportado.** CUDA 13 eliminó Maxwell, Pascal y Volta
  (todo lo anterior a Turing) y «CUDA 13.0 supports all NVIDIA
  architectures from Turing through Grace Blackwell»; la guía WSL lo
  repite para el guest: «CUDA Toolkit 13.x supports Turing and later
  GPU architectures». La RTX 2060 (sm_75, Turing) queda dentro.
- **WSL2 sin toolkit del sistema.** El driver Windows se mapea en el
  guest como `libcuda` (no se instala driver Linux en WSL) y el
  runtime CUDA viaja dentro de las ruedas `nvidia-*`.

Fuentes (consultadas el 2026-11-21):

- CUDA Toolkit 13.5 Release Notes, §2.2 «CUDA Driver» (tablas 2–3):
  <https://docs.nvidia.com/cuda/cuda-toolkit-release-notes/index.html>
- CUDA Toolkit 13.0 Release Notes, §2.3.1 y §2.6.2:
  <https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/index.html>
- CUDA on WSL User Guide, §2.1 y §4:
  <https://docs.nvidia.com/cuda/wsl-user-guide/index.html>

Residuales de EJECUCIÓN (no del lock; los declara el inventario de
Malintzin §4): confirmar que el build trae `sm_75`
(`torch.cuda.get_arch_list()`) y medir la VRAM libre junto a LFM3
(~1,7 GB). Si CUDA no está disponible o la inferencia falla en
ejecución, el comportamiento ya documentado arriba aplica (vuelta a
CPU / diar_failed).

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
