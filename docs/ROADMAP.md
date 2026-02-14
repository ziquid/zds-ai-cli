# ZDS AI CLI Roadmap

## Version 0.2.0

### Features

- [  ] 1: CODE IMPROVEMENTS
   - [  ] 1.1: Introduce StreamingLLMAgent class
   - [  ] 1.2: Start separating FE and BE
   - [  ] 1.3: Refactor settings manager
      - Clean up settings-manager.ts code structure
      - Improve error handling and validation
      - Simplify the interface for loading/saving settings
      - Better separation of user vs project settings
   - [  ] 1.4: Add support for Grok xAI Messages API

- [  ] 2: DATA PERSISTENCE
   - [  ] 2.1: Migrate context storage from JSON files to SQLite database
      - Replace context.json with SQLite schema
      - Maintain backward compatibility for reading old JSON files
      - Improve query performance for large conversation histories
      - Enable better analytics and search capabilities

- [  ] 3: MISC IMPROVEMENTS
   - [  ] 3.1: Consider integrating [Agent Skills](https://agentskills.io)
   - [  ] 3.2: Add preUserInput hook

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
