#!/usr/bin/env zsh

ME=$(basename "$0")

# Parse arguments for --tone, --move, --video, --try-video options
TONE_ARG=
MOVE_ARG=
VIDEO_MODE=  # empty=none, "required"=--video, "try"=--try-video

while [[ $# -gt 0 ]]; do
  case $1 in
    --tone)
      TONE_ARG="$2"
      shift 2
      ;;
    --move)
      MOVE_ARG=--move
      shift
      ;;
    --video)
      VIDEO_MODE=required
      shift
      ;;
    --try-video)
      VIDEO_MODE=try
      shift
      ;;
    --help|-h)
      echo "Usage: ${ME} [--tone <tone>] [--move] [--video|--try-video] [<filename.txt> | -]"
      echo
      echo Arguments:
      echo "  --tone <tone>           Speech tone (slow, fast, romantic, etc.)"
      echo "  --move                  Move output files to ZAI directory instead of local output"
      echo "  --video                 Generate lip-synced video; error if no video provider configured"
      echo "  --try-video             Generate lip-synced video if configured, fall back to audio if not"
      echo "  <filename.txt>          Text file to convert to speech"
      echo "  -                       Read text from stdin instead of file"
      echo
      echo Examples:
      echo "  ${ME} myfile.txt                       # Basic conversion"
      echo "  ${ME} --tone romantic love_letter.txt  # Romantic tone"
      echo "  ${ME} --move myfile.txt                # Move to ZAI directory"
      echo "  ${ME} --tone slow --move poem.txt      # Slow tone + move"
      echo "  ${ME} --try-video myfile.txt           # Video if configured, else audio"
      echo "  ${ME} --video myfile.txt               # Video only (error if not configured)"
      echo "  echo Hello | ${ME} -                   # Convert stdin text"
      echo "  ${ME} --help                           # Show this help message"
      echo
      echo Encoded speech audio/video filename will be printed to stdout.
      exit 0
      ;;
    *)
      # Store remaining arguments for processing
      break
      ;;
  esac
done

# Build arguments for talking script, including tone and move if specified
TALKING_ARGS=()
[[ -n "$TONE_ARG" ]] && TALKING_ARGS+=("$TONE_ARG")
[[ -n "$MOVE_ARG" ]] && TALKING_ARGS+=("$MOVE_ARG")

# Handle stdin input if needed
if [[ "${@:$#}" == - || -z "$1" ]]; then
  tmp=$(mktemp $TMPDIR/$ME.$$.XXXXXX).txt
  cat > $tmp
  TALKING_ARGS+=("${@[1,-2]}" "$tmp")
else
  TALKING_ARGS+=("$@")
fi

# No video mode: simple passthrough
if [[ -z "$VIDEO_MODE" ]]; then
  talking-agents.sh "${TALKING_ARGS[@]}"
  exit $?
fi

# Video mode: generate audio then video
AUDIO_FILE=$(talking-agents.sh "${TALKING_ARGS[@]}")
TTS_EXIT=$?

[[ $TTS_EXIT -ne 0 || -z "$AUDIO_FILE" ]] && exit ${TTS_EXIT:-1}

VIDEO_FILE=$(video-agents.sh "$AUDIO_FILE")
VIDEO_EXIT=$?

if [[ $VIDEO_EXIT -eq 0 && -n "$VIDEO_FILE" ]]; then
  echo "$VIDEO_FILE"
  exit 0
fi

[[ "$VIDEO_MODE" == required ]] && exit ${VIDEO_EXIT:-1}
echo "$AUDIO_FILE"
exit 0
