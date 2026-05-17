#!/usr/bin/env zsh
# generate_image_sd.sh - Generate image via SD API, save base64/JSON/PNG

# Load environment variables early (needed for help text defaults)
[[ -f ~/.env ]] && source ~/.env

# Defaults - only MOVE_DIR is optional
WIDTH=512
HEIGHT=768
SAMPLER="DPM++ 2M SDE Karras"
CFG_SCALE=5.0
MODEL_CHECKPOINT=cyberrealisticPony_v160.safetensors
STEPS=30

# Show help before any env validation so it works outside agent context
if [[ "$1" == --help || "$1" == -h || $# -eq 0 ]]; then
  ME=$(basename "$0")
  echo "Usage: ${ME} <prompt> [<negative prompt>] [options...]"
  echo
  echo Generate images using Stable Diffusion API
  echo
  echo Arguments:
  echo "  <prompt>                 Text prompt for image generation (required)"
  echo "  <negative prompt>        Text prompt for what to avoid (optional)"
  echo
  echo Options:
  echo "  --move                   Move generated image to external folder"
  echo "  --width <num>            Set width (default: $WIDTH)"
  echo "  --height <num>           Set height (default: $HEIGHT)"
  echo "  --cfg-scale <value>      Set CFG scale (default: $CFG_SCALE)"
  echo "  --steps <count>          Number of sampling steps (default: $STEPS)"
  echo "  --sampler <sampler>      Sampler (default: $SAMPLER)"
  echo "  --model <model>          Model Checkpoint (default: ${MODEL_CHECKPOINT/.safetensors/})"
  echo "  --seed <num>             Seed for reproducible generation (default: random)"
  echo "  --name <name>            Name to call the file (default: based on prompt)"
  echo "  --list-models            Show checkpoint models installed"
  echo "  --list-loras             Show LoRAs installed"
  echo "  --get-lora-details <name> Show complete JSON details for specified LoRA"
  echo "  --help                   Show this help message"
  echo
  echo Environment Variables:
  echo "  ZDS_AI_IMAGE_ENDPOINT    API endpoint URL (required)"
  echo "  ZDS_AI_IMAGE_MOVE_DIR    Directory for --move option (optional -- --move ignored if not set)"
  echo
  echo Examples:
  echo "  ${ME} 'tropical beach'"
  echo "  ${ME} 'mountain landscape' 'blurry' --width 1024"
  echo "  ${ME} 'sunset' --move --cfg-scale 7.5"
  echo "  ${ME} 'whistler\'s mother' --steps 50 --cfg-scale 8.0 --name 'whistlers mom'"
  echo "  ${ME} 'portrait' --seed 12345 --name 'reproducible-portrait'"
  echo "  ${ME} --get-lora-details 'RealisticSkinv2_ponyv6_loraplus'"
  exit 0
fi

# Agent environment validation (skipped for --help above)
[[ ! -s "$ZDS_AI_AGENT_CONFIG_FILE" ]] && echo Failed to find config file $ZDS_AI_AGENT_CONFIG_FILE >&2 && exit 1
[[ ! -s "$ZDS_AI_AGENT_LOG_FILE" ]] && echo Failed to find log file $ZDS_AI_AGENT_LOG_FILE >&2 && exit 1
[[ -z "$ZDS_AI_AGENT_SESSION" ]] && echo Failed to validate agent session >&2 && exit 1
[[ -z "$ZDS_AI_AGENT_HOME_DIR" ]] && echo Failed to validate agent home dir >&2 && exit 1
LOGFILE=${ZDS_AI_AGENT_LOG_FILE}
ENDPOINT="$ZDS_AI_IMAGE_ENDPOINT/txt2img"

( date
printf "%s %s\n" "$0" "$@"
[[ -n "$ZDS_AI_AGENT_SESSION" ]] || set | grep ^ZDS_AI
echo ) >> $LOGFILE

# set -x

# Required environment variables
if [[ -z "$ZDS_AI_IMAGE_ENDPOINT" ]]; then
  {
    echo Error: ZDS_AI_IMAGE_ENDPOINT environment variable must be set
    echo
    echo Example setup:
    echo "  export ZDS_AI_IMAGE_ENDPOINT='http://my.sd.server.net:7860/sdapi/v1'"
    echo
    echo Optional: Also set ZDS_AI_IMAGE_MOVE_DIR for --move functionality:
    echo "  export ZDS_AI_IMAGE_MOVE_DIR='/path/to/your/images'"
  } >&2
  exit 1
fi

# Initialize flags and collect positional arguments
MOVE_FLAG=false
CFG_SCALE_OVERRIDE=
STEPS_OVERRIDE=
SEED=-1
POSITIONAL_ARGS=()

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --move)
      if [[ -z "$ZDS_AI_IMAGE_MOVE_DIR" ]]; then
        echo "Warning: --move flag ignored because ZDS_AI_IMAGE_MOVE_DIR is not set" >&2
      else
        MOVE_FLAG=true
      fi
      shift # past argument
      ;;
    --model)
      MODEL_CHECKPOINT="$2.safetensors"
      shift 2 # past argument and value
      ;;
    --name)
      NAME="$2"
      shift 2 # past argument and value
      ;;
    --width)
      WIDTH="$2"
      shift 2 # past argument and value
      ;;
    --height)
      HEIGHT="$2"
      shift 2 # past argument and value
      ;;
    --cfg-scale)
      CFG_SCALE_OVERRIDE="$2"
      shift 2 # past argument and value
      ;;
    --sampler)
      SAMPLER="$2"
      shift 2 # past argument and value
      ;;
    --steps)
      STEPS_OVERRIDE="$2"
      shift 2 # past argument and value
      ;;
    --seed)
      SEED="$2"
      shift 2 # past argument and value
      ;;
    --list-loras)
      curl -s "$ZDS_AI_IMAGE_ENDPOINT"/loras | jq -r '.[].name'
      exit 0
      ;;
    --list-models)
      curl -s "$ZDS_AI_IMAGE_ENDPOINT"/sd-models | jq -r '.[].title' | \
        sed -e 's,\.safetensors.*,,gi'
      exit 0
      ;;
    --get-lora-details)
      LORA_NAME="$2"
      if [[ -z "$LORA_NAME" ]]; then
        echo "Error: Lora name is required for --get-lora-details" >&2
        exit 1
      fi
      curl -s "$ZDS_AI_IMAGE_ENDPOINT"/loras | jq --arg name "$LORA_NAME" '.[] | select(.name == $name)'
      exit 0
      ;;
    -*|--*)
      echo "Unknown option $1"
      exit 1
      ;;
    *)
      POSITIONAL_ARGS+=("$1") # save positional arg
      shift # past argument
      ;;
  esac
done

# Restore positional parameters
set -- "${POSITIONAL_ARGS[@]}"

# Set positional arguments
PROMPT="$1"
NEGATIVE_PROMPT="${2:-score_6, score_5, score_4, (worst quality:1.2), (low quality:1.2), (normal quality:1.2), lowres, bad anatomy, bad hands, signature, watermarks, ugly, imperfect eyes, skewed eyes, unnatural face, unnatural body, error, extra limb, missing limbs}"

# Override with command line flags if specified
[[ -n "$CFG_SCALE_OVERRIDE" ]] && CFG_SCALE="$CFG_SCALE_OVERRIDE"
[[ -n "$STEPS_OVERRIDE" ]] && STEPS="$STEPS_OVERRIDE"

# Validate that we have at least a prompt
if [[ -z "$PROMPT" ]]; then
  echo "Error: Prompt is required" >&2
  echo "Usage: $0 <prompt> [<negative prompt>] [options...]" >&2
  exit 1
fi

# Validate numeric values
if [[ -n "$CFG_SCALE_OVERRIDE" && ! "$CFG_SCALE_OVERRIDE" =~ ^[0-9]+\.?[0-9]*$ ]]; then
  echo "Error: --cfg-scale must be a positive number" >&2
  exit 1
fi

if [[ -n "$STEPS_OVERRIDE" && ! "$STEPS_OVERRIDE" =~ ^[1-9][0-9]*$ ]]; then
  echo "Error: --steps must be a positive integer" >&2
  exit 1
fi
if [[ -n "$SEED_OVERRIDE" && ! "$SEED_OVERRIDE" =~ ^[0-9]+$ ]]; then
  echo "Error: --seed must be a non-negative integer" >&2
  exit 1
fi

# Slugify, if needed
NAME=${NAME:-${PROMPT}}
SLUG=$(echo -n $NAME | tr '[:space:]' '_' | sed -e 's/[^a-zA-Z0-9_]/_/g' | cut -c 1-32)

# Dirs
OUTDIR=${ZDS_AI_AGENT_HOME_DIR}/out
mkdir -p $OUTDIR/photos/tmp
OUTPUT_B64=$OUTDIR/photos/tmp/${SLUG}.b64
OUTPUT_PNG=$OUTDIR/photos/${SLUG}.png
OUTPUT_JSON=$OUTDIR/photos/tmp/${SLUG}_response.json

echo "Generating: '$PROMPT' (SLUG: $SLUG)"
echo "Negative: '$NEGATIVE_PROMPT', Steps: $STEPS"
echo "Dimensions: ${WIDTH}x${HEIGHT}, CFG Scale: $CFG_SCALE, Seed: $SEED"

# --arg lora_tag "<lora:RealisticSkinv2_ponyv6_loraplus:0.4>"
# Payload
PAYLOAD=$(jq -n \
  --arg prompt "$PROMPT" --arg negative_prompt "$NEGATIVE_PROMPT, EasyNegative" --argjson steps "$STEPS" \
  --arg sampler_index "$SAMPLER" --argjson width $WIDTH --argjson height $HEIGHT \
  --argjson cfg_scale $CFG_SCALE --arg sd_model_checkpoint "$MODEL_CHECKPOINT"  \
  --argjson seed $SEED \
  '{
    prompt: $prompt, negative_prompt: $negative_prompt, steps: $steps,
    sampler_index: $sampler_index, width: $width, height: $height, cfg_scale: $cfg_scale,
    seed: $seed, batch_size: 1, n_iter: 1, send_images: true,
    override_options: { sd_model_checkpoint: $sd_model_checkpoint }
  }')

echo PAYLOAD: $PAYLOAD >> $LOGFILE

# Curl to JSON file
curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "$ENDPOINT" > "$OUTPUT_JSON" 2>> "$LOGFILE"
if [[ $? -ne 0 ]]; then
  echo Curl failed.  Check SD endpoint.  output: | tee -a "$LOGFILE" >&2
  cat $OUTPUT_JSON >&2
  exit 1
fi

# Extract base64 from JSON
jq -r '.images[0] // empty' "$OUTPUT_JSON" > "$OUTPUT_B64"
if [[ ! -s "$OUTPUT_B64" ]]; then
  echo "No image.  Raw response in $OUTPUT_JSON:" >&2
  jq -r . --indent 2 $OUTPUT_JSON >&2
  exit 1
fi

rm $OUTPUT_JSON

base64 -d < "$OUTPUT_B64" > "$OUTPUT_PNG"
if [[ ! -s "$OUTPUT_PNG" ]]; then
  echo "No image!" | tee -a "$LOGFILE" >&2
  exit 1
fi

{
  rm $OUTPUT_B64
  file $OUTPUT_PNG
  ls -l $OUTPUT_PNG

  # Move PNG to ZAI if flag set
  if [[ $MOVE_FLAG == true ]]; then
    mv -v "$OUTPUT_PNG" "$ZDS_AI_IMAGE_MOVE_DIR/"
    echo "$ZDS_AI_IMAGE_MOVE_DIR"/$(basename "$OUTPUT_PNG")
  else
    echo ${OUTPUT_PNG}
  fi
} | tee -a $LOGFILE

exit 0
