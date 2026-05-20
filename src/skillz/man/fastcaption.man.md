---
name: fastcaption.sh
purpose: generate image captions using an Ollama vision model
invocation: fastcaption.sh <image_file>
audience: agents
relevance: when generating descriptions or captions for images
---

# fastcaption

Generate a caption or description for an image using an Ollama-hosted vision model.  The image is base64-encoded and sent to the Ollama API for analysis.

## USAGE

`fastcaption.sh <image_file>`

- `<image_file>`: path to the image file to caption (required)

Caption text is printed to stdout.

## ENVIRONMENT

- `ZDS_AI_AGENT_CONFIG_FILE`: path to the agent's config.zds.yml
- `ZDS_AI_AGENT_SESSION`: agent session identifier
- `ZDS_AI_IMAGE_CAPTION_MODEL`: Ollama model to use (default: `qwen3-vl:235b-instruct-cloud`)
- `OLLAMA_API_KEY`: API key for Ollama cloud (required)

## EXAMPLES

1. `fastcaption.sh photo.jpg`: generate a caption for a photo
2. `fastcaption.sh screenshot.png`: describe a screenshot

## EXIT CODES

- `0`: success
- `1`: failure (missing API key, model error)
