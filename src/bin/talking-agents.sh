#!/usr/bin/env zsh

# set -x

# Load environment variables
[[ -f ~/.env ]] && source ~/.env

# Find config from ZDS_AI_AGENT_CONFIG_FILE
[[ ! -s "$ZDS_AI_AGENT_CONFIG_FILE" ]] && echo Failed to find config file $ZDS_AI_AGENT_CONFIG_FILE >&2 && exit 1
[[ ! -s "$ZDS_AI_AGENT_LOG_FILE" ]] && echo Failed to find log file $ZDS_AI_AGENT_LOG_FILE >&2 && exit 1
[[ -z "$ZDS_AI_AGENT_SESSION" ]] && echo Failed to validate agent session >&2 && exit 1
LOGFILE=${ZDS_AI_AGENT_LOG_FILE}

# Log the tool invocation
{
  echo "=== $(basename "$0") Tool Fired: $(date) ==="
  echo Agent bot name: ${ZDS_AI_AGENT_BOT_NAME}
  echo
  set | grep ^ZDS_AI_AGENT_ | grep -vE ^ZDS_AI_AGENT_'(BOT_NAME=)'
  echo
  echo Params: "$@"
  echo
} >> $LOGFILE

_build_voice_strings() {
  local yq_path=$1
  local voice_parts=()
  local voice_remote_parts=()
  local voice_count=$(yq "${yq_path}.kokoro.voices | length" "$ZDS_AI_AGENT_CONFIG_FILE")

  for ((i=0; i<voice_count; i++)); do
    local name=$(yq "${yq_path}.kokoro.voices[$i].name" "$ZDS_AI_AGENT_CONFIG_FILE")
    local weight=$(yq "${yq_path}.kokoro.voices[$i].weight" "$ZDS_AI_AGENT_CONFIG_FILE")
    voice_parts+=("${name}:${weight}")
    voice_remote_parts+=("${name}(${weight})")
  done

  echo "$(IFS=',' ; echo "${voice_parts[*]}")|$(IFS='+' ; echo "${voice_remote_parts[*]}")"
}

_load_mode_config() {
  local mode=$1

  if [[ $(yq ".speech.$mode.speechify" "$ZDS_AI_AGENT_CONFIG_FILE") != null ]]; then
    PROVIDER=speechify
    SPEECHIFY_VOICE_ID=$(yq ".speech.$mode.speechify.voice_id" "$ZDS_AI_AGENT_CONFIG_FILE")
    SPEED=$(yq ".speech.$mode.speechify.speed // \"1.0\"" "$ZDS_AI_AGENT_CONFIG_FILE")
    NORM=$(yq ".speech.$mode.speechify.norm // \"-3\"" "$ZDS_AI_AGENT_CONFIG_FILE")
    PITCH=$(yq ".speech.$mode.speechify.pitch // \"0\"" "$ZDS_AI_AGENT_CONFIG_FILE")
  else
    PROVIDER=kokoro
    SPEED=$(yq ".speech.$mode.kokoro.speed" "$ZDS_AI_AGENT_CONFIG_FILE")
    NORM=$(yq ".speech.$mode.kokoro.norm" "$ZDS_AI_AGENT_CONFIG_FILE")
    PITCH=$(yq ".speech.$mode.kokoro.pitch" "$ZDS_AI_AGENT_CONFIG_FILE")

    local voices=$(_build_voice_strings ".speech.$mode")
    VOICE="${voices%|*}"
    VOICE_REMOTE="${voices#*|}"
  fi
}

# Load default TTS configuration
_load_mode_config default
CURRENT_MODE=default

SUFFIX=
MOVE_FLAG=
EXT=mp3

# for var in SPEED NORM PITCH VOICE_REMOTE SUFFIX; do
#   echo $var = ${(P)var} >> $LOGFILE
# done

_tts_fix_audio() {
  ffmpeg -v error -i "$1" -af deesser,haas=side_gain=0.3,\
arnndn=/usr/local/share/models/cb.rnnn,\
afftdn=nr=10:nf=-80:tn=1,adynamicsmooth=2,anlmdn=m=99,\
adynamicsmooth=99:999 -y "$2" | tee -a "$LOGFILE"
}

_tts_postprocess_audio() {
  sox "$1" "$2" pad 0 1 norm ${NORM} pitch ${PITCH} | tee -a "$LOGFILE"
}

_tts_render_kokoro() {
#   kokoro -s 0.77 -m af_bella -i "$1" -o "$2" || :
#   cd ~/scm/kokoro-tts
  kokoro-tts "$1" "$2" --speed $SPEED --voice ${VOICE} \
    --model ~/.cache/kokoro-tts/kokoro-v1.0.onnx \
    --voices ~/.cache/kokoro-tts/voices-v1.0.bin
#   ERR=$?
#   cd -
#   return $ERR
}

_tts_get_language() {
  echo $1 | lingua-cli -l en,es,pt | cut -c -2 | \
    sed -e 's,^en$,en-us,gi' -e 's,^pt$,pt-br,gi'
}

# Get voice and speed for a specific language, trying language-specific mode variant first
_get_language_voice_config() {
  local mode=$1
  local language=$2
  local lang_var=$(echo "$language" | sed 's/-/_/g')
  local lang_mode="${mode}_${lang_var}"

  # Try language-specific variant first (e.g., loving_es for Spanish)
  if [[ $(yq ".speech.$lang_mode" "$ZDS_AI_AGENT_CONFIG_FILE") != null ]]; then
    local voices=$(_build_voice_strings ".speech.$lang_mode")
    local speed=$(yq ".speech.$lang_mode.kokoro.speed" "$ZDS_AI_AGENT_CONFIG_FILE")
    echo "${voices%|*}|$speed"
  else
    # Fall back to base mode
    echo "$VOICE_REMOTE|$SPEED"
  fi
}

# New function to accept content directly instead of reading from file
_tts_render_kokoro_remote_content() {
  local content="$1"
  local output_file="$2"
  local language=$(_tts_get_language "$1")

  # Get language-appropriate voice and speed for current mode
  local config=$(_get_language_voice_config "$CURRENT_MODE" "$language")
  local use_voice="${config%|*}"
  local use_speed="${config#*|}"

  curl -s -X POST "${ZDS_AI_TTS_ENDPOINT}" \
    -u "${ZDS_AI_TTS_USER}:${ZDS_AI_TTS_PASS}" \
    -H "Content-Type: application/json" \
    -H "X-Raw-Response: true" \
    -d '{
      "input": "'"${content}"'",
      "model": "kokoro",
      "voice": "'${use_voice}'",
      "response_format": "wav",
      "speed": '${use_speed}',
      "stream": false,
      "lang_code": "'${language}'",
      "return_download_link": true
    }' > "$output_file" 2>> "$LOGFILE"
}

# en-us, es, pt-br, hi, it, fr-fr, zh

# Function to split text into sentences using awk
_tts_split_text_into_sentences() {

  # Read file and split into sentences (basic sentence splitting)
  # This splits on periods, exclamation marks, question marks, and ellipsis
  awk '{
    # Split on sentence endings while keeping the punctuation
    gsub(/[\.!?…]/, "&\n")
    print
  }' | \
  awk 'NF > 0 {
    # Clean up whitespace
    gsub(/^[[:space:]]+|[[:space:]]+$/, "")
    if (length($0) > 0) {
      print $0
    }
  }'
}

# New function to split text into sentences and process them individually
_tts_render_kokoro_remote_sentences() {
  local input_file="$1"
  local output_file="$2"
  local temp_dir=$(mktemp -d "${2}.temp.XXXXXX") || return 1
  local pad_amount=$(echo "scale=2; 0.7 / $SPEED" | bc)

  # Split text into sentences first
  _tts_split_text_into_sentences < "$input_file" > "$temp_dir/sentences.txt"

  # Process each sentence
  local sentence_num=0
  local all_wav_files=()

  while IFS= read -r sentence; do
    if [[ -n "$sentence" ]]; then
      sentence_num=$((sentence_num + 1))
      wav_file="$temp_dir/sentence_${sentence_num}.wav"

      # Process this sentence directly without writing to file
      if _tts_render_kokoro_remote_content "$sentence" "$wav_file"; then
        if [[ ${sentence_num} -eq 1 ]]; then
          all_wav_files+=($wav_file)
        else
          sox $wav_file ${wav_file}.padded.wav pad ${pad_amount} 0
          all_wav_files+=($wav_file.padded.wav)
        fi
      fi
    fi
  done < "$temp_dir/sentences.txt"

  if [[ ${sentence_num} -eq 0 ]]; then
    rm -rf $temp_dir
    return 1
  fi

  sox $all_wav_files "$output_file" rate 48k
  rm -rf $temp_dir
  return 0
}

_tts_render_speechify_content() {
  local content="$1"
  local output_file="$2"
  local language=$(_tts_get_language "$content")

  curl -s -X POST "https://api.speechify.ai/v1/audio/speech" \
    -H "Authorization: Bearer ${SPEECHIFY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"input\": $(echo "$content" | jq -Rs .), \"voice_id\": \"${SPEECHIFY_VOICE_ID}\", \"audio_format\": \"wav\", \"language\": \"${language}\"}" \
    2>> "$LOGFILE" | jq -r '.audio_data' | base64 -d > "$output_file"
}

_tts_render_speechify_sentences() {
  local input_file="$1"
  local output_file="$2"

  _tts_render_speechify_content "$(cat "$input_file")" "$output_file"
}

_tts_prep_file() {
  FILE_TYPE=$(file -b "$1")
  echo $FILE_TYPE
  echo $FILE_TYPE | grep -q -s CRLF.\*line.terminators && dos2unix "$1"
  if echo $FILE_TYPE | grep -q -s Non-ISO.extended-ASCII; then
    iconv -c -f macroman -t ascii < "$1" > "$1.ascii"
    cat "$1.ascii" > "$1"
    rm "$1.ascii"
  fi
  # Sanitize text for TTS using pandoc (auto-detect format)
  pandoc -t plain --wrap=none "$1" | \
    tr -cd '[:alnum:][:space:][:punct:]\n' > "$1.tmp" && mv "$1.tmp" "$1"
}

_die() {
  echo $* >&2
  exit 1
}

if [[ "$1" == --move ]]; then
  MOVE_FLAG=true
  shift
fi

# Check if a custom mode is defined in config
if [[ -n "$1" && "$1" != --move && "$1" != slow && "$1" != fast && ! -f "$1" ]]; then
  if [[ $(yq ".speech.$1" "$ZDS_AI_AGENT_CONFIG_FILE") != null ]]; then
    _load_mode_config "$1"
    CURRENT_MODE="$1"
    SUFFIX=-$1
    shift
  fi
fi

if [[ "$1" == slow ]]; then
  SPEED=$(echo "$SPEED * 0.9" | bc -S 2 | awk '{printf "%f", $0}')
  NORM=$((NORM - 2))
  PITCH=$((PITCH - 40))
  SUFFIX="${SUFFIX}-slow"
  shift
fi

if [[ "$1" == fast ]]; then
  SPEED=$(echo "$SPEED * 1.2" | bc -S 2 | awk '{printf "%f", $0}')
  NORM=$((NORM + 2))
  PITCH=$((PITCH + 40))
  SUFFIX="${SUFFIX}-fast"
  shift
fi

local outdir=${ZDS_AI_AGENT_HOME_DIR:+$ZDS_AI_AGENT_HOME_DIR/}out/Speech/
mkdir -p ${outdir} || _die could not create ${outdir}
[[ -d "$ZDS_AI_TTS_MOVE_DIR" ]] && MOVE_DIR="$ZDS_AI_TTS_MOVE_DIR" || \
  MOVE_DIR="$outdir"

# for var in SPEED NORM PITCH VOICE_REMOTE SUFFIX MOVE_DIR; do
#   echo $var = ${(P)var} >> $LOGFILE
# done

# for a in pre/*(N); do
for a in "$@"; do
  [[ "$a" == --move ]] && MOVE_FLAG=true && continue

  b=${outdir}$(basename "$a" .txt)$SUFFIX.$$
  (
#    _tts_render_kokoro "$a" "${b}-temp1.wav" || continue
    if [[ "$PROVIDER" == speechify ]]; then
      _tts_render_speechify_sentences "$a" "${b}-temp1.wav" || continue
    else
      _tts_prep_file "$a"
      _tts_render_kokoro_remote_sentences "$a" "${b}-temp1.wav" || continue
    fi
    _tts_fix_audio "${b}-temp1.wav" "${b}-temp2.wav" || continue
    _tts_postprocess_audio "${b}-temp2.wav" "${b}.wav" || continue
    rm -f "${b}-temp1.wav" "${b}-temp2.wav"
    echo "${b}.wav"
    soxi "${b}.wav"
    sox "${b}.wav" "${b}.$EXT"
  ) > ${b}.stdout.txt 2> ${b}.stderr.txt
  if [[ -s "${b}.$EXT" ]]; then
    rm "${b}.stdout.txt"
    rm "${b}.stderr.txt"
    if [[ $MOVE_FLAG == true ]]; then
      mv -v "${b}.$EXT" "$MOVE_DIR"
      rm "${b}.wav"
      echo "$MOVE_DIR"/$(basename "${b}.$EXT")
    else
      echo "${b}.$EXT"
    fi
  else
    cat "${b}.stdout.txt"
    cat "${b}.stderr.txt" >&2
    exit 1
  fi
done

exit 0
