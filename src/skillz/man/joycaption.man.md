---
name: joycaption.sh
purpose: generate image captions using the JoyCaption service
invocation: joycaption.sh <image_file> [--prompt <prompt_text>]
audience: agents
relevance: when generating detailed image captions via JoyCaption
---

# joycaption

Generate captions for images using the JoyCaption service running on the asrock host.  The image is uploaded via SCP and processed remotely.

## USAGE

`joycaption.sh <image_file> [--prompt <prompt_text>]`

- `<image_file>`: path to the image file to caption (required)
- `--prompt <prompt_text>`: optional prompt to guide the captioning
- `-h, --help`: show help and exit

Caption text is printed to stdout.

## EXAMPLES

1. `joycaption.sh image.jpg`: generate a caption with default prompt
2. `joycaption.sh image.png --prompt "Describe this image in detail"`: guided captioning

## PREREQUISITES

- SSH access to the `asrock` host
- JoyCaption service running on asrock at `bin/joycaption-receiver`

## EXIT CODES

- `0`: success
- `1`: failure (missing file, SSH error, service error)
