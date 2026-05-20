---
name: video-agents.sh
purpose: generate lip-synced video from audio using the ExHuman API
invocation: video-agents.sh <audio_file.mp3>
audience: agents
relevance: when generating lip-synced video from TTS audio output
---

# video-agents

Generate a lip-synced video from an audio file using the ExHuman API.  Takes an MP3 audio file (typically produced by talking-agents.sh) and combines it with an idle video to produce a lip-synced MP4.

The video provider configuration is read from the agent's config.zds.yml under `video.default.ex-human`.

## USAGE

`video-agents.sh <audio_file.mp3>`

- `<audio_file.mp3>`: path to the input audio file (required)

On success, the output MP4 filename is printed to stdout.  On failure, an error message is printed to stderr and the script exits non-zero.

## ENVIRONMENT

- `ZDS_AI_AGENT_CONFIG_FILE`: path to the agent's config.zds.yml (required).  The `video.default.ex-human.idle_url` setting is read from this file.
- `EXHUMAN_API_TOKEN`: Bearer token for the ExHuman API (required)

## CONFIG

Video settings are read from the agent's config.zds.yml:

```yaml
video:
   default:
      ex-human:
         idle_url: "https://example.com/idle-video.mp4"
```

## EXAMPLES

1. `video-agents.sh ~/out/Speech/response.mp3`: generate lip-synced video from TTS output
2. Combined with encode-speech: `encode-speech --video myfile.txt` (encode-speech calls video-agents.sh automatically when --video is specified)

## EXIT CODES

- `0`: success (MP4 filename printed to stdout)
- `1`: failure (missing config, missing API token, API error, HTTP error)

## SEE ALSO

- [encode-speech](encode-speech) -- wrapper that orchestrates TTS and video generation
- [talking-agents](talking-agents) -- TTS engine that produces the audio input
