# ZDS AI CLI Roadmap

## Version 0.1.9

### Features

- [✅] 1: HOOKS
   - [✅] 1.1: Rename prePrompt to preLLMResponse
   - [✅] 1.2: Add postUserInput hook
   - [✅] 1.3: Add postLLMResponse hook
   - [✅] 1.4: Add preToolCall hook
   - [✅] 1.5: Add postToolCall hook

- [✅] 2: HOOK COMMANDS
   - [✅] 2.1: Add MAXCONTEXT command for setting maximum context length

- [✅] 3: CODE IMPROVEMENTS
   - [✅] 3.1: Move sessionState to top of context.json file
   - [✅] 3.2: added /context reload command to reload context verbatim

- [✅] 4: Tool enhancements
   - [✅] 4.1: Add encode-speech tool
   - [✅] 4.2: Add getLoraDetails to ImageTool
   - [✅] 4.3: Add compareImageToPrompt to ImageTool
   - [✅] 4.4: Add joycaption.sh helper script to repository

- [✅] 5: TECHNICAL DEBT
   - [✅] 5.1: Reduce duplicate code in llm-agent.ts
   - [✅] 5.2: Refactor llm-agent.ts to move tasks to helpers

- [✅] 6: DOCUMENTATION IMPROVEMENTS
   - [✅] 6.1: Update the morph tool instructions
   - [✅] 6.2: Update the README
   - [✅] 6.3: Documented classes in src/agent
   - [✅] 6.4: Add AGENTS.md

- [✅] 7: CLI USABILITY IMPROVEMENTS
   - [✅] 7.1: Add `/? ` as shorter alias for `/introspect` command
   - [✅] 7.2: Enhanced `/? ` (introspect) output formatting
      - Added color-coded output (cyan for values, yellow for properties, magenta for templates, dim for comments)
      - Improved YAML-like tree structure for variable definitions
      - Show explicit/implicit indicator for variable definitions
      - Display current values in def: output when available
      - Better error messages suggesting def: when var: not found

- [✅] 8: FILE LOCATION MIGRATION
   - [✅] 8.1: Move settings from ~/.grok/ to ~/.zds-ai/
      - User settings: ~/.grok/user-settings.json → ~/.zds-ai/cli-settings.json
      - MCP config: ~/.grok/mcp.json → ~/.zds-ai/mcp.json
      - Project settings: .grok/settings.json → .zds-ai/project-settings.json
      - Chat history: ~/.grok/chat-history.json → ~/.zds-ai/context.json

- [✅] 9: PROMPT VARIABLE SYSTEM IMPROVEMENTS
   - [✅] 9.1: Add SESSION variables for session state tracking
      - SESSION:BACKEND:MODEL (weight 10, persistent)
      - SESSION:BACKEND:SERVICE (weight 20, persistent)
      - SESSION:FRONTEND (weight 30, persistent)
      - SESSION:STDIN_IS_TTY (weight 31, persistent)
      - SESSION:STDOUT_IS_TTY (weight 31, persistent)
   - [✅] 9.2: Dynamic system message rendering
      - System prompt now renders from variables before each LLM call
      - `getSystemPrompt()` automatically renders current variable state
      - `setSystemPrompt()` deprecated - always renders from variables
      - Ensures instance hook variables always included in fresh sessions
      - `renderSystemMessage()` method added to LLMAgent and HookManager

### Bug Fixes

- [✅] 1: Fixed backend/model switching regression (dependency injection using getters)
- [✅] 2: Fixed session state persistence (persona, apiKeyEnvVar now save correctly)
- [✅] 3: Fixed hook prompt variable commands (SET, SET_FILE, SET_TEMP_FILE) not being applied
- [✅] 4: Fixed hook ENV commands not being applied in llm-agent.ts hooks
- [✅] 5: Save permanent prompt vars with context.json
- [✅] 6: Fixed /introspect and /? commands not showing user input in chat history
- [✅] 7: Fixed SET/SET_FILE/SET_TEMP_FILE regex to allow underscores in variable names
- [✅] 8: Fixed XML wrapping logic for prompt variables (now checks child's template, not parent's)
- [✅] 9: Fixed findBirthChildren to only return immediate children, not grandchildren
- [✅] 10: Fixed var: output showing "Values (0)" - now shows "No direct values (renders from children/getter)"
- [✅] 11: Fixed var: output not showing children (now displays children list matching def: output)
- [✅] 12: Fixed empty child wrapper tags being rendered - now only creates XML wrappers when child has content
- [✅] 13: Fixed orphaned grandchildren not appearing in parent render - automatically creates intermediate parents (e.g., MESSAGE:ACL when MESSAGE:ACL:CURRENT exists)
- [✅] 14: Persona is not being saved in context.json when personas are changed (PR #53)
- [✅] 15: Fixed Variable.set() semantics to replace values instead of appending (Issue #28)
- [✅] 16: Fixed APP:TOOLS duplication by tracking seen variables and using append() for duplicates (Issue #28)
- [✅] 17: Migrated Grok API from deprecated search_parameters to Agent Tools API (Issue #25)
   - Fixed 410 error "Live search is deprecated"
   - Added WebSearchTool interface with full filter support
   - Updated chat() and chatStream() to use tools array with {type: "web_search"}
   - Maintains backward compatibility -- old search_parameters auto-convert to new format
- [✅] 18: Disabled Grok web_search tool due to API inconsistencies (PR #49)
   - Temporarily disabled web_search tool creation in chat() and chatStream() methods
   - Agents should use Tavily for web search instead
   - Code preserved for future re-enable when Grok API behavior is clarified
- [✅] 19: Fixed persona/mood/task not being restored in session resume (Issue #27)
   - hookManager.setPersona/setMood/startActiveTask now call deps methods to update agent properties
   - Previously only set environment variables, causing getPersona/getMood/getActiveTask to return empty strings
   - Fixes bug where persona was saved to context.json but not restored on session resume
- [✅] 20: Fixed OpenAI API error with tools array exceeding 128 tool limit (Issue #55)
   - OpenAI has hard limit of 128 tools per request
   - Added tool count check in chat() and chatStream() methods
   - Trims tools array to 128 when using OpenAI backend (base tools prioritized over MCP tools)
   - Logs warning when trimming occurs
- [✅] 21: Fixed OpenAI API 400 error with newer models requiring max_completion_tokens (Issue #57)
   - OpenAI models from gpt-5.x, o1, o3, o4-mini onwards require max_completion_tokens instead of max_tokens
   - Added model detection logic to use correct parameter based on model name
   - Applied to both chat() and chatStream() methods in src/grok/client.ts
   - Maintains backward compatibility for older models and non-OpenAI backends
- [✅] 22: Fixed Dependabot security vulnerabilities blocking v0.1.9 release (Issue #59)
   - Updated @modelcontextprotocol/sdk to 1.26.0 (fixes ReDoS and cross-client data leak)
   - Updated ink to 6.6.0 (resolves lodash prototype pollution)
   - Added qs override to 6.14.1 (fixes DoS vulnerability)
   - Resolved all 10 vulnerabilities (6 high, 4 moderate)

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
   - [  ] 1.3: Add support for Grok xAI Messages API

- [  ] 2: DATA PERSISTENCE
   - [  ] 2.1: Migrate context storage from JSON files to SQLite database
      - Replace context.json with SQLite schema
      - Maintain backward compatibility for reading old JSON files
      - Improve query performance for large conversation histories
      - Enable better analytics and search capabilities

- [  ] 3: MISC IMPROVEMENTS
   - [  ] 3.1: Consider integrating [Agent Skills](https://agentskills.io)
   - [  ] 3.2: Add preUserInput hook
