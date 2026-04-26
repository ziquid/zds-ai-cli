#!/usr/bin/env zsh

ME=$(basename "$0")
AUDIO_FILE="$1"

IDLE_URL=$(yq '.video.default.ex-human.idle_url' "$ZDS_AI_AGENT_CONFIG_FILE" 2>/dev/null)

[[ -z "$IDLE_URL" || "$IDLE_URL" == null ]] && \
  echo ${ME}: no video.default.ex-human configured in ${ZDS_AI_AGENT_CONFIG_FILE} >&2 && exit 1

[[ -z "$EXHUMAN_API_TOKEN" ]] && echo ${ME}: EXHUMAN_API_TOKEN not set >&2 && exit 1

VIDEO_FILE="${AUDIO_FILE%.mp3}.mp4"
REQUEST_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')

HTTP_CODE=$(curl -s --max-time 17 \
  --request POST \
  --url "https://api.exh.ai/animations/v3/generate_lipsync_from_audio" \
  --header "X-Request-Id: ${REQUEST_ID}" \
  --header "accept: application/json" \
  --header "authorization: Bearer ${EXHUMAN_API_TOKEN}" \
  --form "idle_url=${IDLE_URL}" \
  --form "audio_file=@${AUDIO_FILE};type=audio/mpeg" \
  -o "${VIDEO_FILE}" \
  -w "%{http_code}" 2>/dev/null)

VIDEO_EXIT=$?

[[ $VIDEO_EXIT -eq 0 && "$HTTP_CODE" == 200 && -s "$VIDEO_FILE" ]] && echo "$VIDEO_FILE" && exit 0

rm -f "$VIDEO_FILE"
echo ${ME}: ExHuman API call failed -- curl exit ${VIDEO_EXIT}, http ${HTTP_CODE:-n/a} >&2
exit 1
