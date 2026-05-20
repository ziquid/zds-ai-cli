---
name: generate_image_sd.sh
purpose: generate images using Stable Diffusion API
invocation: generate_image_sd.sh <prompt> [<negative prompt>] [options...]
audience: agents
relevance: when generating images from text prompts
---

# generate-image-sd

Generate images using a Stable Diffusion API endpoint.  Supports configurable dimensions, sampling parameters, model selection, and seed control.

## USAGE

`generate_image_sd.sh <prompt> [<negative prompt>] [options...]`

- `<prompt>`: text prompt for image generation (required)
- `<negative prompt>`: text prompt for what to avoid (optional)
- `--move`: move generated image to external folder
- `--width <num>`: image width (default: 480)
- `--height <num>`: image height (default: 720)
- `--cfg-scale <value>`: CFG scale (default: 5.0)
- `--steps <count>`: number of sampling steps (default: 30)
- `--sampler <sampler>`: sampler name (default: "DPM++ 2M Karras")
- `--model <model>`: model checkpoint (default: cyberrealisticPony_v130)
- `--seed <num>`: seed for reproducible generation (default: random)
- `--name <name>`: output filename (default: based on prompt)
- `--list-models`: show installed checkpoint models
- `--get-lora-details <name>`: show JSON details for a specified LoRA
- `-h, --help`: show help and exit

## ENVIRONMENT

- `ZDS_AI_AGENT_CONFIG_FILE`: path to the agent's config.zds.yml (required)
- `ZDS_AI_AGENT_LOG_FILE`: path to the agent's log file (required)
- `ZDS_AI_AGENT_SESSION`: agent session identifier (required)

## EXAMPLES

1. `generate_image_sd.sh "a sunset over mountains"`: basic image generation
2. `generate_image_sd.sh "portrait of a woman" "blurry, low quality" --width 512 --height 768`: with negative prompt and custom dimensions
3. `generate_image_sd.sh "landscape" --steps 50 --cfg-scale 7.0`: custom sampling parameters
4. `generate_image_sd.sh --list-models`: list available models

## EXIT CODES

- `0`: success
- `1`: failure (missing config, API error)
