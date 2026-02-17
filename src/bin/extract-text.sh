#!/usr/bin/env zsh

ME=$(basename "$0")

# Check for help option
if [[ "$1" == --help || "$1" == -h ]]; then
  echo Usage: $ME '<file>'
  echo
  echo Extract text from audio or image files using appropriate tools.
  echo
  echo Arguments:
  echo "  <file>           Path to audio or image file"
  echo
  echo Supported file types:
  echo "  Audio files      MP3, WAV, M4A, etc. (uses Whisper)"
  echo "  Image files      JPG, PNG, GIF, etc. (uses Textra or Tesseract)"
  echo
  echo Examples:
  echo '  extract-text recording.mp3'
  echo '  extract-text screenshot.jpg'
  echo
  echo Output:
  echo '  Extracted text printed to stdout'
  echo
  exit 0
fi

# Check if file argument provided
if [[ -z "$1" ]]; then
  echo ❌ Error: No file specified >&2
  echo Use --help for usage information >&2
  exit 1
fi

# Check if file exists
if [[ ! -f "$1" ]]; then
  echo ❌ Error: File not found: $1 >&2
  exit 1
fi

# Detect platform, MIME type
platform=$(uname)
mime_type=$(file --mime-type -b "$1")

# Route to appropriate extraction tool
case "$mime_type" in
  audio/*)
    [[ -s ~zds-ai/.cache/whisper/small.pt ]] && \
      typeset -gx XDG_CACHE_HOME=~zds-ai/.cache
    whisper --output_format txt --model small "$1" 2> /dev/null | \
      grep -vE "^Detecting.language|^Detected.language"
    ;;
  image/*)
    if [[ "$platform" == Darwin ]]; then
      # macOS: use textra
      textra -s "$1" 2> /dev/null | cat
    else
      # Linux: use tesseract
      tesseract "$1" stdout 2> /dev/null
    fi
    ;;
  *)
    echo ❌ Error: Unsupported file type: $mime_type >&2
    echo Supported types: 'audio/*, image/*' >&2
    exit 1
    ;;
esac

exit 0
