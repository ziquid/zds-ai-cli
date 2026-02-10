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
