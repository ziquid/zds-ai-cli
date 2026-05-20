---
name: talking-agents.sh
purpose: text-to-speech engine supporting Kokoro and Speechify providers
invocation: talking-agents.sh [--move] [<mode>] [slow|fast] <file.txt>...
audience: agents
relevance: when generating speech audio with provider-specific configuration
---

# talking-agents

Core TTS engine for ZDS AI agents.  Reads the agent's config.zds.yml to determine the speech provider (Kokoro or Speechify), voice settings, and audio processing parameters.  Converts text files to processed audio with denoising, normalization, and pitch adjustment.

Typically invoked via encode-speech rather than directly.

## USAGE

`talking-agents.sh [--move] [<mode>] [slow|fast] <file.txt>...`

- `--move`: move output files to the ZAI TTS move directory instead of local output
- `<mode>`: custom speech mode defined in the agent's config.zds.yml (e.g., a named profile under `speech.<mode>`)
- `slow`: reduce speed by 10%, lower normalization by 2dB, lower pitch by 40 cents
- `fast`: increase speed by 20%, raise normalization by 2dB, raise pitch by 40 cents
- `<file.txt>`: one or more text files to convert (supports .txt, .md, and other text formats via pandoc)

Output audio files are written to `~/out/Speech/` (or `$ZDS_AI_TTS_MOVE_DIR` if set).

## ENVIRONMENT

- `ZDS_AI_AGENT_CONFIG_FILE`: path to the agent's config.zds.yml (required)
- `ZDS_AI_AGENT_LOG_FILE`: path to the agent's log file (required)
- `ZDS_AI_AGENT_SESSION`: agent session identifier (required)
- `ZDS_AI_AGENT_HOME_DIR`: agent home directory for output path
- `ZDS_AI_TTS_ENDPOINT`: Kokoro TTS endpoint URL (required for Kokoro provider)
- `ZDS_AI_TTS_MOVE_DIR`: override directory for output files
- `SPEECHIFY_API_KEY`: API key for Speechify TTS (required for Speechify provider)

## CONFIG

Speech settings are read from the agent's config.zds.yml:

```yaml
speech:
   default:
      kokoro:
         speed: 1.0
         norm: -3
         pitch: 0
         voices:
            - name: af_bella
              weight: 1.0
      speechify:
         voice_id: kristy
         speed: 1.0
         norm: -3
         pitch: 0
```

## EXIT CODES

- `0`: success
- `1`: failure (missing config, missing log file, TTS provider error)

## SEE ALSO

- [encode-speech](encode-speech) -- simplified wrapper for this tool
