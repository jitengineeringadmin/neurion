# neurion/image-worker:0.1.0 — REAL local text-to-image (SD-Turbo), CPU, offline.
# The model is baked at build time so the --network none job sandbox can load it
# with no network access.
FROM python:3.11-slim

WORKDIR /worker
ENV HF_HOME=/worker/.hf \
    PIP_NO_CACHE_DIR=1

# CPU-only torch (no CUDA) keeps the image far smaller, then the diffusion stack.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.4.1 \
 && pip install diffusers==0.31.0 transformers==4.44.2 accelerate==0.34.2 safetensors==0.4.5 pillow==10.4.0

COPY run.py ./

# Bake SD-Turbo into the image's HF cache (network is available at build time only).
RUN python -c "import torch; from diffusers import AutoPipelineForText2Image; AutoPipelineForText2Image.from_pretrained('stabilityai/sd-turbo', torch_dtype=torch.float32)"

# Runtime is offline — load the baked model from cache, never the network.
ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

ENTRYPOINT ["python", "run.py"]
