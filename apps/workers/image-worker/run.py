#!/usr/bin/env python3
# image.v1 worker — REAL local text-to-image (SD-Turbo via diffusers), CPU.
# Runs fully offline: the model is baked into the image at build time (the job
# sandbox runs with --network none).
# Contract: --input /job/input.json --output /job/output.json
import argparse
import base64
import io
import json
import os
import time

MODEL = "stabilityai/sd-turbo"


def clamp_int(v, lo, hi, default):
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def dim(v, default):
    # SD wants dimensions that are multiples of 64, in [256, 1024]
    return int(round(clamp_int(v, 256, 1024, default) / 64) * 64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="/job/input.json")
    ap.add_argument("--output", default="/job/output.json")
    args = ap.parse_args()
    started = time.time()

    with open(args.input, "r", encoding="utf-8") as f:
        inp = json.load(f)

    prompt = (inp.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt required")
    negative = (inp.get("negative") or "").strip()
    width = dim(inp.get("width"), 512)
    height = dim(inp.get("height"), 512)
    steps = clamp_int(inp.get("steps"), 1, 8, 2)  # SD-Turbo is a few-step model
    seed = inp.get("seed")

    # Offline at runtime — the model is already in the baked HF cache.
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    import torch
    from diffusers import AutoPipelineForText2Image

    torch.set_num_threads(max(1, os.cpu_count() or 1))
    pipe = AutoPipelineForText2Image.from_pretrained(MODEL, torch_dtype=torch.float32)
    pipe = pipe.to("cpu")
    pipe.set_progress_bar_config(disable=True)

    generator = torch.Generator("cpu")
    used_seed = -1
    try:
        if seed is not None and int(seed) >= 0:
            used_seed = int(seed)
            generator = generator.manual_seed(used_seed)
    except (TypeError, ValueError):
        pass

    # SD-Turbo: guidance_scale must be 0.0 (no CFG).
    image = pipe(
        prompt=prompt,
        negative_prompt=negative or None,
        num_inference_steps=steps,
        guidance_scale=0.0,
        width=width,
        height=height,
        generator=generator,
    ).images[0]

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    out = {
        "success": True,
        "result": {"image": b64, "width": width, "height": height, "seed": used_seed, "model": "sd-turbo"},
        "metrics": {"durationMs": int((time.time() - started) * 1000)},
    }
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"image.v1 (sd-turbo) {width}x{height} steps={steps} -> {args.output}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — worker must always write an output file
        ap = argparse.ArgumentParser()
        ap.add_argument("--input", default="/job/input.json")
        ap.add_argument("--output", default="/job/output.json")
        a, _ = ap.parse_known_args()
        try:
            with open(a.output, "w", encoding="utf-8") as f:
                json.dump({"success": False, "error": str(e)}, f)
        except OSError:
            pass
        print(f"image.v1 failed: {e}")
        raise SystemExit(1)
