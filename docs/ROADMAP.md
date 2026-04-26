# ZDS AI CLI Roadmap

## Version 0.2.0

### Features

- [  ] 1: CODE IMPROVEMENTS
   - [  ] 1.1: Introduce StreamingLLMAgent class
   - [  ] 1.2: Start separating FE and BE
   - [🔘] 1.3: Refactor settings manager
      - [  ] 1.3.1: Clean up settings-manager.ts code structure
      - [  ] 1.3.2: Improve error handling and validation
      - [  ] 1.3.3: Simplify the interface for loading/saving settings
      - [  ] 1.3.4: Better separation of user vs project settings
      - [✅] 1.3.5: Add CLI arg to use custom user settings path
   - [✅] 1.4: Add support for Grok xAI Messages API
   - [✅] 1.5: Add MCP tool denylist to exclude unwanted tools from LLM context (Backlog #15)
   - [✅] 1.6: Add CONTINUE Hook Command
   - [  ] 1.7:

- [  ] 2: DATA PERSISTENCE
   - [  ] 2.1: Migrate context storage from JSON files to SQLite database
      - Replace context.json with SQLite schema
      - Maintain backward compatibility for reading old JSON files

- [  ] 3: MISC IMPROVEMENTS
   - [  ] 3.1: Consider integrating [Agent Skills](https://agentskills.io)
   - [  ] 3.2: Add preUserInput hook
   - [✅] 3.3: Add support for Speechify to talking-agents.sh
   - [✅] 3.4: Add video-agents.sh

### Bug Fixes

- [✅] 1: Fixed USER:* prompt variables not being sent to LLM (Issue #68)
   - Moved parseAndAssembleMessage() to execute AFTER PreLLMResponse hook
   - Ensures all USER:* variables (USER:PRE, USER:ENV, USER:RAG, USER:GUIDANCE, USER:POST) are set before message assembly
   - Fixed in both processUserMessage() and processUserMessageStream() methods
- [✅] 2: Fixed backend model test failure when switching personas with same model (Issue #70)
   - Only trigger model test when new model differs from current model
   - Prevents unnecessary test when switching personas that share the same model
   - Fixes 500 errors from Ollama when attempting to switch from a model to itself
- [✅] 3: Fixed character loss during typing after Ink 6.6.0 upgrade (Issue #73)
   - Consolidated three competing useInput hooks into single unified handler
   - Prevents input events from being split across multiple handlers
   - Resolves intermittent character loss (every 3rd-4th keystroke) reported after React 19/Ink 6.6.0 upgrade
- [✅] 4: Increased default max_tokens from 10 to 500 for model compatibility tests (Issue #75)
   - Updated both testModel() and testBackendModelChange() functions
   - Allows more comprehensive model validation during persona/backend switches
   - Provides more representative test responses for compatibility checking
- [✅] 5: Fixed post-llmresponse hook execution order (Issue #80)
   - Hook now executes AFTER LLM response is saved to context.json
   - Ensures hooks have immediate access to complete conversation including latest response
   - Fixed in all three code paths: non-streaming with tools, non-streaming final response, and streaming
   - Enables hooks to read full conversation state when making decisions
- [✅] 6: Fixed task invocations not saving existing context files to backup (Issue #83)
   - Both `--prompt` (headless) and `--no-ink` (plain console) modes now call clearHistory() for fresh sessions
   - Fixed `zai t` (which uses `--prompt` mode) to properly backup context before starting new tasks
   - Fixed SSH sessions using `--no-ink` to properly backup context before fresh sessions
   - Matches UI mode behavior by backing up existing context before starting new session
   - Prevents loss of previous session data when starting tasks
   - Ensures both `zai t` and `zai nc` properly backup context files to context-backup directory
- [✅] 7: Optional MCP servers with missing environment variables no longer spam warnings (Issue #82)
   - MCP servers requiring undefined environment variables are silently skipped with a single informative notice
   - Displays one consolidated warning per session listing all affected servers and their missing variables
   - Prevents repeated console spam from optional servers like tavily when API keys aren't configured
   - Server configs with unresolved ${VAR} placeholders are automatically treated as disabled
- [✅] 8: Additional work on character loss issue (Issue #73)
   - Memoized ChatHistory, CommandSuggestions, ModelSelection, RephraseMenu, MCPStatus components
   - Simplified ChatInput to single Text component with ANSI escape codes
   - Added refs in useEnhancedInput to track current input/cursor values
   - Reduced character loss from >30% to <5%
- [✅] 9: fixed extract-text.sh to only set XDG_ROOT if the Whisper cache is primed
- [✅] 10: Upgraded whisper model from base to small for better transcription accuracy (Issue #97)
   - Changed speech-to-text model from 'base' (74M params) to 'small' (244M params)
   - Improves transcription accuracy, especially for proper names, accents, and unclear audio
   - Trade-off: +323MB model size, ~2.5x slower processing, +1GB memory requirement
   - Model is cached in the container image (no download required at runtime)
