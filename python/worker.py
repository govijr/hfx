"""hfx inference worker: loads one model and serves JSON-line requests on stdin.

usage: worker.py <image|video|vision> <model_dir> <output_dir>
Every line on stdout is a JSON event; library chatter goes to stderr.
"""
import json
import os
import sys
import time
import traceback

OUT = sys.stdout
sys.stdout = sys.stderr  # keep stdout clean for the protocol


def emit(**event):
    OUT.write(json.dumps(event) + "\n")
    OUT.flush()


def pick_device():
    import torch

    if torch.cuda.is_available():
        return "cuda", torch.bfloat16
    if torch.backends.mps.is_available():
        return "mps", torch.bfloat16
    return "cpu", torch.float32


def load_diffusers(path, dtype, device):
    from diffusers import DiffusionPipeline

    try:
        pipe = DiffusionPipeline.from_pretrained(path, torch_dtype=dtype, variant="fp16")
    except Exception:
        pipe = DiffusionPipeline.from_pretrained(path, torch_dtype=dtype)
    if device == "cuda" and hasattr(pipe, "enable_model_cpu_offload"):
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(device)
    if hasattr(pipe, "vae") and hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()
    return pipe


def to_pil(frame):
    from PIL import Image
    import numpy as np

    if isinstance(frame, Image.Image):
        return frame
    arr = np.asarray(frame)
    if arr.dtype != np.uint8:
        arr = (arr.clip(0, 1) * 255).round().astype("uint8")
    return Image.fromarray(arr)


def main():
    task, path, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(outdir, exist_ok=True)
    emit(type="status", text="importing torch…")
    import torch

    device, dtype = pick_device()
    emit(type="status", text=f"loading weights on {device}…")

    if task in ("image", "video"):
        pipe = load_diffusers(path, dtype, device)
    elif task == "vision":
        from transformers import pipeline

        pipe = pipeline("image-text-to-text", model=path, device=device, torch_dtype=dtype)
    else:
        raise SystemExit(f"unknown task {task}")
    emit(type="ready", device=device)

    for line in sys.stdin:
        if not line.strip():
            continue
        req = json.loads(line)
        rid = req.get("id")
        started = time.time()
        try:
            if task in ("image", "video"):
                steps = int(req.get("steps") or 28)

                def on_step(_pipe, i, _t, kwargs):
                    emit(type="progress", id=rid, step=i + 1, total=steps)
                    return kwargs

                kwargs = dict(prompt=req["prompt"], num_inference_steps=steps, callback_on_step_end=on_step)
                if req.get("guidance") is not None:
                    kwargs["guidance_scale"] = float(req["guidance"])
                if req.get("seed") is not None:
                    kwargs["generator"] = torch.Generator("cpu").manual_seed(int(req["seed"]))
                stamp = time.strftime("%Y%m%d-%H%M%S")
                if task == "image":
                    image = pipe(**kwargs).images[0]
                    out = os.path.join(outdir, f"{stamp}.png")
                    image.save(out)
                    emit(type="image", id=rid, path=out, seconds=time.time() - started)
                else:
                    from diffusers.utils import export_to_video

                    if req.get("frames"):
                        kwargs["num_frames"] = int(req["frames"])
                    frames = pipe(**kwargs).frames[0]
                    frames = [to_pil(f) for f in frames]
                    out = os.path.join(outdir, f"{stamp}.mp4")
                    poster = os.path.join(outdir, f"{stamp}.poster.png")
                    export_to_video(frames, out, fps=int(req.get("fps") or 16))
                    frames[len(frames) // 2].save(poster)
                    emit(type="video", id=rid, path=out, poster=poster, frames=len(frames), seconds=time.time() - started)
            else:
                content = [{"type": "image", "url": p} for p in req.get("images", [])]
                content.append({"type": "text", "text": req["prompt"]})
                history = req.get("history", []) + [{"role": "user", "content": content}]
                result = pipe(text=history, max_new_tokens=int(req.get("max_tokens") or 768), return_full_text=False)
                text = result[0]["generated_text"]
                if isinstance(text, list):
                    text = text[-1].get("content", "")
                emit(type="text", id=rid, text=text, seconds=time.time() - started)
        except Exception as e:  # report and keep serving
            traceback.print_exc()
            emit(type="error", id=rid, message=f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        traceback.print_exc()
        emit(type="fatal", message=f"{type(e).__name__}: {e}")
        sys.exit(1)
