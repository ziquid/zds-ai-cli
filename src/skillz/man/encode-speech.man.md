---
name: encode-speech.sh
purpose: convert text to speech audio using the agent's configured TTS provider
invocation: encode-speech.sh [--tone <tone>] [--move] [--video|--try-video] [<filename.txt> | -]
audience: agents
relevance: when generating speech audio from text
---

# encode-speech

Convert a text file (or stdin) to speech audio -- or lip-synced video -- using the agent's configured TTS provider (Kokoro or Speechify).  This is a wrapper around talking-agents.sh that provides a simpler interface for text-to-speech conversion.  When `--video` or `--try-video` is specified, the audio is passed to video-agents.sh to generate a lip-synced video.

## USAGE

`encode-speech.sh [--tone <tone>] [--move] [--video|--try-video] [<filename.txt> | -]`

- `--tone <tone>`: speech tone modifier (slow, fast, romantic, etc.)
- `--move`: move output files to the ZAI directory instead of local output
- `--video`: generate a lip-synced video from the audio; error if no video provider is configured
- `--try-video`: generate a lip-synced video if a video provider is configured, fall back to audio-only if not
- `<filename.txt>`: text file to convert to speech
- `-`: read text from stdin instead of a file
- `-h, --help`: show help and exit

The encoded speech audio or video filename is printed to stdout.

## ENVIRONMENT

- `ZDS_AI_AGENT_CONFIG_FILE`: path to the agent's config.zds.yml (required).  The TTS provider and voice settings are read from the `speech` section of this file.
- `ZDS_AI_AGENT_LOG_FILE`: path to the agent's log file (required)
- `ZDS_AI_AGENT_SESSION`: agent session identifier (required)
- `SPEECHIFY_API_KEY`: API key for Speechify TTS (required if using Speechify provider)
- `ZDS_AI_TTS_ENDPOINT`: endpoint URL for Kokoro TTS (required if using Kokoro provider)

## EXAMPLES

1. `encode-speech.sh myfile.txt`: basic text-to-speech conversion
1. `encode-speech.sh --tone romantic love_letter.txt`: convert with romantic tone
1. `encode-speech.sh --move myfile.txt`: convert and move output to ZAI directory
1. `encode-speech.sh --tone slow --move poem.txt`: slow tone with move
1. `encode-speech.sh --try-video myfile.txt`: generate video if configured, otherwise audio-only
1. `encode-speech.sh --video myfile.txt`: generate video (error if no video provider configured)
1. `echo "Hello" | encode-speech.sh -`: convert text from stdin

## EXIT CODES

- `0`: success
- `1`: failure (missing config, missing log file, TTS provider error)

## SEE ALSO

- [talking-agents](talking-agents) -- the underlying TTS engine that encode-speech.sh wraps
- [video-agents](video-agents) -- the lip-sync video engine used by `--video` and `--try-video`
