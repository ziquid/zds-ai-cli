#!/usr/bin/env zsh

ME=$(basename "$0")

# Parse arguments for --tone and --move options
TONE_ARG=
MOVE_ARG=

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
    --help|-h)
      echo "Usage: ${ME} [--tone <tone>] [--move] [<filename.txt> | -]"
      echo
      echo Arguments:
      echo "  --tone <tone>           Speech tone (slow, fast, romantic, etc.)"
      echo "  --move                  Move output files to ZAI directory instead of local output"
      echo "  <filename.txt>          Text file to convert to speech"
      echo "  -                       Read text from stdin instead of file"
      echo
      echo Examples:
      echo "  ${ME} myfile.txt                       # Basic conversion"
      echo "  ${ME} --tone romantic love_letter.txt  # Romantic tone"
      echo "  ${ME} --move myfile.txt                # Move to ZAI directory"
      echo "  ${ME} --tone slow --move poem.txt      # Slow tone + move"
      echo "  echo Hello | ${ME} -                   # Convert stdin text"
      echo "  ${ME} --help                           # Show this help message"
      echo
      echo Encoded speech audio filename will be printed to stdout.
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

# Call the talking script with all arguments
talking-agents.sh "${TALKING_ARGS[@]}"
