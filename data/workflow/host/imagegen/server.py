#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "torch>=2.4",
#   "diffusers>=0.31",
#   "transformers>=4.44",
#   "accelerate>=0.34",
#   "peft>=0.13",
#   "safetensors>=0.4",
#   "fastapi>=0.115",
#   "uvicorn>=0.30",
#   "pillow>=10.4",
# ]
# ///
"""
Scene image generator for the shadowing pipeline.

Runs on the HOST, not in a container, and that is not a style choice: Docker
Desktop on macOS cannot reach the Metal GPU - `/dev` inside the n8n container has
no GPU device at all - so a containerised diffusion model would fall back to CPU
and take minutes per image. The n8n container calls in over
`http://host.docker.internal:7860`, which was verified to resolve from inside it.

Model is SD 1.5 with the LCM LoRA, which brings sampling down to 4 steps. Chosen
over SDXL on measured size: 2.68 GB against 6.46 GB, for images that end up
dimmed 10%, cropped to 9:16 and covered by a subtitle scrim. The prompts this
receives are concrete noun phrases ("cafe counter coffee croissant"), which is
what SD 1.5 is good at.
"""
import io
import os
import time

import torch
from PIL import Image, ImageEnhance
from diffusers import AutoencoderKL, LCMScheduler, StableDiffusionPipeline
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

# Realistic Vision V6, a photoreal finetune of SD 1.5. Same architecture, so the
# SD 1.5 LCM LoRA still applies and generation stays at roughly 7 seconds; it is
# simply trained on better photographs than the base model. Loaded from the
# single fp16 checkpoint (1.99 GB) rather than the diffusers folder, which is
# fp32 .bin files plus a safety checker and comes to about 5 GB for the same
# weights.
# Counterfeit V2.5, an anime finetune of SD 1.5 - 1.99 GB, same architecture, so
# the LCM LoRA still applies and generation stays around 8 seconds.
#
# Chosen over the photoreal finetune for one reason: these videos star two fixed
# anime characters, and a drawn face has no uncanny valley to fall into. Measured
# trade-off, worth knowing before switching back: this model is noticeably LOOSER
# at following a prompt. "a server rack with a red warning light" came back as a
# red-lit corridor, and a group scene with no clear subject came back as a grid
# of sketches. It wants ONE character doing ONE thing, which is what the Groq
# prompt now asks for.
#
# Swap models with IMAGEGEN_MODEL; the photoreal one that was here before is
# SG161222/Realistic_Vision_V6.0_B1_noVAE, file Realistic_Vision_V6.0_NV_B1_fp16.
MODEL = os.environ.get(
    "IMAGEGEN_MODEL",
    "https://huggingface.co/gsdf/Counterfeit-V2.5/"
    "blob/main/Counterfeit-V2.5_fp16.safetensors")
# "noVAE" in that repo name is not decoration: the checkpoint ships without one,
# so it has to be supplied or the decoder produces colour mush.
VAE = os.environ.get("IMAGEGEN_VAE", "stabilityai/sd-vae-ft-mse")
LCM_LORA = os.environ.get("IMAGEGEN_LCM", "latent-consistency/lcm-lora-sdv1-5")

# Character lock. Every video is the same two people, so each scene is generated
# with the speaking character's portrait fed in through IP-Adapter alongside the
# text prompt. `-plus-face` is the face-focused variant - the plain adapter copies
# the whole reference including its composition, which would give six near
# identical portraits instead of six different scenes.
#
# Honest limit: this produces a character who LOOKS like the reference, not a
# pixel-identical one. Frame to frame the hair, eyes and clothing hold; the face
# drifts a little. Locking identity exactly needs a LoRA trained on the character,
# which is a different and much larger job.
IP_ADAPTER = os.environ.get("IMAGEGEN_IP_ADAPTER", "h94/IP-Adapter")
IP_WEIGHT_NAME = os.environ.get("IMAGEGEN_IP_WEIGHT", "ip-adapter-plus-face_sd15.safetensors")
# How hard the reference pulls, and it is a narrower window than it looks.
#
# The adapter does not only carry the face - it carries the reference's whole
# composition, background included. The portraits in assets/characters/ sit on
# plain backgrounds on purpose, so at 0.55 that emptiness bled through and a
# prompt asking for "a busy downtown sidewalk, sunlight between tall buildings"
# rendered as a figure against a flat blue void. Measured on the same prompt and
# seed: 0.55 no scenery, 0.28 good scenery but the hair drifts off-reference,
# 0.40 keeps both.
IP_SCALE = float(os.environ.get("IMAGEGEN_IP_SCALE", 0.40))
CHARACTER_DIR = os.environ.get(
    "IMAGEGEN_CHARACTERS",
    os.path.join(os.path.dirname(__file__), "..", "..", "assets", "characters"))

# Portrait, because every frame ends up cropped to 9:16. Generating square and
# cropping would throw away a third of the pixels and force a bigger upscale.
WIDTH = int(os.environ.get("IMAGEGEN_WIDTH", 512))
HEIGHT = int(os.environ.get("IMAGEGEN_HEIGHT", 768))
STEPS = int(os.environ.get("IMAGEGEN_STEPS", 4))
# 1.0, which switches classifier-free guidance OFF. That is what LCM was
# distilled for, and both halves of the result were measured here: at 1.5 the
# same prompt and seed came back washed out and monochrome, and it took 14s
# against 7s because CFG doubles the forward passes per step. Raising it does not
# buy fidelity, it buys artefacts. Going the other way, 8 steps collapsed into a
# flat texture - LCM is a 4-step sampler, not a slider.
GUIDANCE = float(os.environ.get("IMAGEGEN_GUIDANCE", 1.0))

# Kept deliberately thin. The first version added "shallow depth of field, 35mm,
# candid" and every scene came back blurred past recognition - the style words
# outweighed the subject at 4 steps. Two words of direction is all this needs.
# Scenery-forward, characters understated - the Shinkai register. The setting is
# what a learner looks at while repeating a line, and a detailed background holds
# attention better than a close-up of someone's face. It also plays to the
# model's strengths and away from its weaknesses.
STYLE = os.environ.get(
    "IMAGEGEN_STYLE",
    "makoto shinkai style anime, detailed scenic background, soft natural light, "
    "delicate clean linework, gentle colours, simple character design")
# INERT at the default guidance of 1.0, and that is worth stating plainly rather
# than leaving as a trap for the next reader: diffusers only encodes a negative
# prompt when classifier-free guidance is on, which is `guidance_scale > 1.0`. So
# none of these words do anything unless someone raises guidance - at which point
# generation also halves in speed. Keeping faces out of frame is handled where it
# actually works, in the positive prompt Groq writes.
NEGATIVE = ("text, caption, watermark, logo, signature, frame, border, collage, "
            "cartoon, illustration, 3d render, deformed hands, extra limbs, "
            "distorted face, lowres, jpeg artifacts")

# This model at 4 LCM steps returns images that are very close to grey. Measured
# with ffmpeg signalstats: SATAVG 5.1 out of a 0-255 scale, and asking the prompt
# for "vivid saturated colours" moved it to 5.14 - no effect worth the words. The
# fix that does work is applied to the pixels afterwards. Done here rather than
# in build_video.js because only GENERATED scenes need it; a stock photograph is
# already saturated and would end up garish.
# Pushed harder for the anime model than the photoreal one needed. Two things
# flatten it: LCM at four steps, and IP-Adapter pulling the palette towards the
# reference portraits, which sit on a white background in soft pastels. Measured
# after the old 1.45 boost, scenes still came back at SATAVG 6-9 out of 255.
SATURATION = float(os.environ.get("IMAGEGEN_SATURATION", 1.9))
CONTRAST = float(os.environ.get("IMAGEGEN_CONTRAST", 1.18))

app = FastAPI()
pipe = None
ip_loaded = False
BLANK = Image.new("RGB", (224, 224), (255, 255, 255))
device = "mps" if torch.backends.mps.is_available() else "cpu"


def character_image(name):
    """Portrait for speaker A or B, or None when there is no such file."""
    if not name:
        return None
    path = os.path.join(CHARACTER_DIR, f"{str(name).strip().upper()}.png")
    if not os.path.exists(path):
        return None
    return Image.open(path).convert("RGB")


class Req(BaseModel):
    prompt: str
    # "A" or "B". The dialogue already alternates speakers, so this arrives for
    # free and decides which portrait conditions the image.
    character: str | None = None
    ipScale: float | None = None
    width: int | None = None
    height: int | None = None
    steps: int | None = None
    seed: int | None = None
    # Overridable so the style and sampling can be compared side by side without
    # a restart - reloading the model costs 80 seconds.
    style: str | None = None
    negative: str | None = None
    guidance: float | None = None


def load():
    global pipe, ip_loaded
    if pipe is not None:
        return pipe
    started = time.time()
    # float16 on MPS: half the memory and roughly twice the speed, at the cost of
    # the occasional all-black frame when a value goes NaN. `looks_blank` below
    # catches those so a dud never reaches the video.
    vae = AutoencoderKL.from_pretrained(VAE, torch_dtype=torch.float16)
    if MODEL.startswith("http") or MODEL.endswith(".safetensors"):
        pipe = StableDiffusionPipeline.from_single_file(
            MODEL, torch_dtype=torch.float16, vae=vae,
            safety_checker=None, requires_safety_checker=False,
        )
    else:
        pipe = StableDiffusionPipeline.from_pretrained(
            MODEL, torch_dtype=torch.float16, variant="fp16", vae=vae,
            safety_checker=None, requires_safety_checker=False,
        )
    pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)
    pipe.load_lora_weights(LCM_LORA)
    pipe.fuse_lora()

    # Loaded after fuse_lora: fusing folds the LoRA into the UNet weights, and
    # doing it the other way round has been known to take the adapter with it.
    try:
        pipe.load_ip_adapter(IP_ADAPTER, subfolder="models", weight_name=IP_WEIGHT_NAME)
        pipe.set_ip_adapter_scale(IP_SCALE)
        ip_loaded = True
        print(f"[imagegen] ip-adapter {IP_WEIGHT_NAME} at scale {IP_SCALE}", flush=True)
    except Exception as err:  # noqa: BLE001 - character lock is a nicety, not a dependency
        print(f"[imagegen] no ip-adapter ({err}); generating without character lock", flush=True)

    pipe.to(device)
    pipe.set_progress_bar_config(disable=True)
    print(f"[imagegen] loaded {MODEL.rsplit('/', 1)[-1]} on {device} "
          f"in {time.time() - started:.1f}s", flush=True)
    return pipe


def looks_blank(image) -> bool:
    """fp16 on MPS sometimes returns a solid frame. Cheap to spot, costly to ship."""
    small = image.convert("L").resize((32, 32))
    pixels = list(small.getdata())
    return (max(pixels) - min(pixels)) < 12


@app.get("/health")
def health():
    known = sorted(f[:-4] for f in os.listdir(CHARACTER_DIR)
                   if f.endswith(".png") and len(f) == 5) if os.path.isdir(CHARACTER_DIR) else []
    return {"ok": True, "device": device, "model": MODEL, "loaded": pipe is not None,
            "width": WIDTH, "height": HEIGHT, "steps": STEPS, "characters": known}


@app.post("/generate")
def generate(req: Req):
    p = load()
    started = time.time()
    generator = None
    if req.seed is not None:
        generator = torch.Generator(device="cpu").manual_seed(req.seed)

    style = STYLE if req.style is None else req.style
    reference = character_image(req.character)
    extra = {}

    # Once an IP-Adapter is loaded the UNet ALWAYS expects image embeddings -
    # calling the pipeline without `ip_adapter_image` dies on
    # `argument of type 'NoneType' is not iterable` deep inside unet_2d_condition.
    # So a scene with no character still passes an image, a blank one, with the
    # adapter turned down to zero. Cheaper and far less fragile than unloading
    # and reloading the adapter around every request.
    if ip_loaded:
        extra["ip_adapter_image"] = reference if reference is not None else BLANK
        p.set_ip_adapter_scale(
            0.0 if reference is None
            else (req.ipScale if req.ipScale is not None else IP_SCALE))

    image = p(
        prompt=f"{req.prompt.strip()}, {style}".rstrip(", "),
        negative_prompt=req.negative if req.negative is not None else NEGATIVE,
        width=req.width or WIDTH,
        height=req.height or HEIGHT,
        num_inference_steps=req.steps or STEPS,
        guidance_scale=req.guidance or GUIDANCE,
        generator=generator,
        **extra,
    ).images[0]

    if SATURATION != 1.0:
        image = ImageEnhance.Color(image).enhance(SATURATION)
    if CONTRAST != 1.0:
        image = ImageEnhance.Contrast(image).enhance(CONTRAST)

    if looks_blank(image):
        return JSONResponse(
            {"error": "generated a blank frame", "prompt": req.prompt}, status_code=502)

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    print(f"[imagegen] {time.time() - started:.1f}s  {req.prompt[:60]}", flush=True)
    return Response(
        content=buf.getvalue(), media_type="image/png",
        headers={"X-Generate-Seconds": f"{time.time() - started:.1f}"})


if __name__ == "__main__":
    import uvicorn
    load()
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("IMAGEGEN_PORT", 7860)),
                log_level="warning")
