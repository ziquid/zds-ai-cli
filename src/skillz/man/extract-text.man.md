---
name: extract-text.sh
purpose: extract text from audio or image files
invocation: extract-text.sh <file>
audience: agents
relevance: when extracting text content from audio recordings or images
---

# extract-text

Extract text from audio or image files using the appropriate backend tool.  Audio files are transcribed using Whisper; image files are processed using Textra or Tesseract for OCR.

## USAGE

`extract-text.sh <file>`

- `<file>`: path to an audio or image file (required)
- `-h, --help`: show help and exit

## SUPPORTED FILE TYPES

- **Audio files**: MP3, WAV, M4A, etc. -- transcribed using Whisper
- **Image files**: JPG, PNG, GIF, etc. -- OCR via Textra or Tesseract

Extracted text is printed to stdout.

## EXAMPLES

1. `extract-text.sh recording.mp3`: transcribe an audio file
2. `extract-text.sh screenshot.jpg`: extract text from an image

## EXIT CODES

- `0`: success
- `1`: failure (no file specified, file not found, unsupported file type)
