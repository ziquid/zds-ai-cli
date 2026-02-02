# ZDS AI CLI

A multi-backend conversational AI CLI tool with intelligent text editor capabilities and tool usage.  Supports OpenAI, Anthropic Claude, X.AI Grok, Ollama, and other OpenAI-compatible providers.

<img width="720" height="528" alt="Image" src="https://github.com/user-attachments/assets/f697a273-141e-4f02-8c15-37143aa7ec0e" />

## Features

- **⚡ Multi-Backend Support**: Works with OpenAI, Anthropic Claude, X.AI Grok, Ollama, OpenRouter, and any OpenAI-compatible API
- **📝 Smart File Operations**: AI automatically uses tools to view, create, and edit files
- **⚡ Zsh Integration**: Execute shell commands through natural conversation
- **🔧 Automatic Tool Selection**: AI intelligently chooses the right tools for your requests
- **🚀 Morph Fast Apply**: Optional high-speed code editing at 4,500+ tokens/sec with 98% accuracy
- **🔌 MCP Tools**: Extend capabilities with Model Context Protocol servers (Linear, GitHub, etc.)
- **💬 Interactive UI**: Beautiful terminal interface built with Ink
- **🌍 Global Installation**: Install and use anywhere with `bun add -g @zds-ai/cli`

## Installation

### Prerequisites

- Bun 1.0+ (or Node.js 18+ as fallback)
- API key from your chosen provider:
  - X.AI Grok: Get from [X.AI](https://x.ai)
  - OpenAI: Get from [OpenAI Platform](https://platform.openai.com)
  - Anthropic Claude: Get from [Anthropic Console](https://console.anthropic.com)
  - Ollama: Self-hosted (no API key needed) or Ollama Cloud (get from [Ollama Cloud](https://ollama.com))
  - OpenRouter: Get from [OpenRouter](https://openrouter.ai)
- (Optional, Recommended) Morph API key for Fast Apply editing

### System Dependencies

zai-cli requires the following system tools for certain features:

- **ripgrep** (required for search functionality)
  - macOS: `brew install ripgrep`
  - Ubuntu/Debian: `apt install ripgrep`
  - Windows: `choco install ripgrep` or download from [releases](https://github.com/BurntSushi/ripgrep/releases)
  - Other platforms: See [ripgrep installation guide](https://github.com/BurntSushi/ripgrep#installation)

- **Python 3 with openpyxl** (optional, required for XLSX file reading)
  - Install: `pip3 install openpyxl` or `python3 -m pip install openpyxl`
  - Most systems already have Python 3 installed

- **exiftool** (optional, required for PNG metadata extraction)
  - macOS: `brew install exiftool`
  - Ubuntu/Debian: `apt install libimage-exiftool-perl`
  - Windows: Download from [exiftool.org](https://exiftool.org/)
  - Other platforms: See [exiftool installation guide](https://exiftool.org/install.html)

### Global Installation (Recommended)

```sh
bun add -g @zds-ai/cli

```

Or with npm (fallback):

```sh
npm install -g @zds-ai/cli

```

### Local Development

```sh
git clone <repository>
cd zds-ai-cli
bun install
bun run build
bun link

```

## Setup

### Quick Start with X.AI Grok (Default)

> **Note**: Environment variables use `GROK_*` prefixes (legacy naming from the original fork), but they work with **all backends**, not just Grok.  See "[Using Other Providers](#using-other-providers)" below to configure different backends.

> **Important**: As of December 15, 2025, Grok's `search_parameters` API has been deprecated.  zai-cli now uses the new Agent Tools API for web search functionality.  Old code using `search_parameters` is automatically converted to the new format for backward compatibility.  See [Grok's Agent Tools documentation](https://docs.x.ai/docs/guides/tools/search-tools) for details.

1.  Get your API key from [X.AI](https://x.ai)

2.  Set up your API key (choose one method):

    **Method 1: Environment Variable**

    ```sh
    export GROK_API_KEY=your_api_key_here

    ```

    **Method 2: .env File**

    ```sh
    cp .env.example .env

    # Edit .env and add your API key


    ```

    **Method 3: Command Line Flag**

    ```sh
    zai-cli --api-key your_api_key_here

    ```

    **Method 4: User Settings File**

    Create `~/.zds-ai/cli-settings.json`:

    ```json
    {
      "apiKey": "your_api_key_here"
    }

    ```

### Using Other Providers

zai-cli supports any OpenAI-compatible API.  Set your provider's API key and base URL:

**OpenAI:**

```sh
export GROK_API_KEY=your_openai_key
export GROK_BASE_URL=https://api.openai.com/v1
export GROK_MODEL=gpt-4o

```

**Ollama (Local):**

```sh
export GROK_BASE_URL=http://localhost:11434/v1
export GROK_MODEL=llama3

# No API key needed for local Ollama


```

**OpenRouter:**

```sh
export GROK_API_KEY=your_openrouter_key
export GROK_BASE_URL=https://openrouter.ai/api/v1
export GROK_MODEL=anthropic/claude-4.5-sonnet

```

3. (Optional, Recommended) Get your Morph API key from [Morph Dashboard](https://morphllm.com/dashboard/api-keys)

4.  Set up your Morph API key for Fast Apply editing (choose one method):

    **Method 1: Environment Variable**
    
    ```sh
    export MORPH_API_KEY=your_morph_api_key_here

    ```
    
    **Method 2: .env File**
    
    ```sh

    # Add to your .env file

    MORPH_API_KEY=your_morph_api_key_here

    ```

### Custom Base URL (Optional)

By default, the CLI uses `https://api.x.ai/v1` as the API endpoint.  You can configure a custom endpoint if needed (choose one method):

**Method 1: Environment Variable**

```sh
export GROK_BASE_URL=https://your-custom-endpoint.com/v1

```

**Method 2: Command Line Flag**

```sh
zai-cli --api-key your_api_key_here --base-url https://your-custom-endpoint.com/v1

```

**Method 3: User Settings File**

Add to `~/.zds-ai/cli-settings.json`:

```json
{
  "apiKey": "your_api_key_here",
  "baseURL": "https://your-custom-endpoint.com/v1"
}

```

## Configuration Files

zai-cli uses two types of configuration files to manage settings:

### User-Level Settings (`~/.zds-ai/cli-settings.json`)

This file stores **global settings** that apply across all projects.  These settings rarely change and include:

- **API Key**: Your API key (works with any backend)
- **Base URL**: API endpoint (determines which backend you use)
- **Default Model**: Your preferred model (e.g., `grok-code-fast-1`)
- **Available Models**: List of models you can use

**Example:**

```json
{
  "apiKey": "your_api_key_here",
  "baseURL": "https://api.x.ai/v1",
  "defaultModel": "grok-code-fast-1",
  "models": [
    "grok-code-fast-1",
    "grok-4-latest",
    "grok-3-latest",
    "grok-3-fast",
    "grok-3-mini-fast"
  ],
  "startupHook": "date"
}

```

#### Startup Hook

You can configure a **startup hook** command that runs when zai-cli starts.  The output is automatically added to the system prompt, providing dynamic context about your environment.

**Example use cases:**

- Show current date/time: `"startupHook": "date"`
- Custom environment info: `"startupHook": "/path/to/your/script.sh"`

The command runs with a 10-second timeout and the output appears in the AI's context before custom instructions.

### Project-Level Settings (`.zds-ai/project-settings.json`)

This file stores **project-specific settings** in your current working directory.  It includes:

- **Current Model**: The model currently in use for this project
- **MCP Servers**: Model Context Protocol server configurations

**Example:**

```json
{
  "model": "grok-3-fast",
  "mcpServers": {
    "linear": {
      "name": "linear",
      "transport": "stdio",
      "command": "npx",
      "args": ["@linear/mcp-server"]
    }
  }
}

```

### How It Works

1. **Global Defaults**: User-level settings provide your default preferences
1. **Project Override**: Project-level settings override defaults for specific projects
1. **Directory-Specific**: When you change directories, project settings are loaded automatically
1. **Fallback Logic**: Project model → User default model → System default (`grok-code-fast-1`)

This means you can have different models for different projects while maintaining consistent global settings like your API key.

### Using Other API Providers

**Important**: zai-cli uses **OpenAI-compatible APIs**.  You can use any provider that implements the OpenAI chat completions standard.

**Popular Providers**:

- **X.AI (grok)**: `https://api.x.ai/v1` (default)
- **OpenAI**: `https://api.openai.com/v1`
- **OpenRouter**: `https://openrouter.ai/api/v1`
- **Groq**: `https://api.groq.com/openai/v1`

**Example with OpenRouter**:

```json
{
  "apiKey": "your_openrouter_key",
  "baseURL": "https://openrouter.ai/api/v1",
  "defaultModel": "anthropic/claude-4.5-sonnet",
  "models": [
    "anthropic/claude-4.5-sonnet",
    "openai/gpt-4o",
    "meta-llama/llama-3.1-70b-instruct"
  ]
}

```

## Usage

### Interactive Mode

Start the conversational AI assistant:

```sh
zai-cli

```

Or specify a working directory:

```sh
zai-cli -d /path/to/project

```

### Headless Mode

Process a single prompt and exit (useful for scripting and automation):

```sh
zai-cli --prompt "show me the package.json file"
zai-cli -p "create a new file called example.js with a hello world function"
zai-cli --prompt "run bun test and show me the results" --directory /path/to/project
zai-cli --prompt "complex task" --max-tool-rounds 50  # Limit tool usage for faster execution

```

This mode is particularly useful for:

- **CI/CD pipelines**: Automate code analysis and file operations
- **Scripting**: Integrate AI assistance into shell scripts
- **Terminal benchmarks**: Perfect for tools like Terminal Bench that need non-interactive execution
- **Batch processing**: Process multiple prompts programmatically

### Tool Execution Control

By default, zai-cli allows up to 400 tool execution rounds to handle complex multi-step tasks.  You can control this behavior:

```sh

# Limit tool rounds for faster execution on simple tasks

zai-cli --max-tool-rounds 10 --prompt "show me the current directory"

# Increase limit for very complex tasks (use with caution)

zai-cli --max-tool-rounds 1000 --prompt "comprehensive code refactoring"

# Works with all modes

zai-cli --max-tool-rounds 20  # Interactive mode

```

**Use Cases**:

- **Fast responses**: Lower limits (10-50) for simple queries
- **Complex automation**: Higher limits (500+) for comprehensive tasks
- **Resource control**: Prevent runaway executions in automated environments

### Model Selection

You can specify which AI model to use with the `--model` parameter or `GROK_MODEL` environment variable:

**Method 1: Command Line Flag**

```sh

# Use grok models

zai-cli --model grok-code-fast-1
zai-cli --model grok-4-latest
zai-cli --model grok-3-latest
zai-cli --model grok-3-fast

# Use other models (with appropriate API endpoint)

zai-cli --model gemini-2.5-pro --base-url https://api-endpoint.com/v1
zai-cli --model claude-sonnet-4-20250514 --base-url https://api-endpoint.com/v1

```

**Method 2: Environment Variable**

```sh
export GROK_MODEL=grok-code-fast-1
zai-cli

```

**Method 3: User Settings File**

Add to `~/.zds-ai/cli-settings.json`:

```json
{
  "apiKey": "your_api_key_here",
  "defaultModel": "grok-code-fast-1"
}

```

**Model Priority**: `--model` flag > `GROK_MODEL` environment variable > user default model > system default (grok-code-fast-1)

### Image Support

zai-cli supports sending images to vision-capable AI models.  Use the `@` prefix to reference image files in your messages:

```sh

# Absolute path

zai-cli --prompt "What's in this image? @/Users/joseph/photos/image.jpg"

# Relative path

zai-cli --prompt "Analyze @./screenshot.png"

# Tilde expansion

zai-cli --prompt "Describe @~/Pictures/photo.jpg"

# Paths with spaces (quoted)

zai-cli --prompt 'Compare these images: @"~/My Pictures/photo1.jpg" @"~/My Pictures/photo2.jpg"'

# Paths with spaces (escaped)

zai-cli --prompt "What's here? @/Users/joseph/My\ Documents/image.png"

```

**Supported Image Formats**: .jpg, .jpeg, .png, .gif, .webp, .bmp

**Vision-Capable Models**: Image support works with vision models like:
- `grok-4-1-fast-reasoning`
- `grok-vision-beta`
- Other vision-enabled models (via custom base URLs)

**Automatic Fallback**: If you send an image to a model that doesn't support vision, zai-cli will automatically detect the error and retry with text-only content.

**Interactive Mode**: The `@` syntax works in both interactive and headless (`--prompt`) modes.

### Command Line Options

```sh
zai-cli [options]

Options:
  -V, --version                       output the version number
  -d, --directory <dir>               set working directory
  -k, --api-key <key>                 API key for your backend (or set GROK_API_KEY env var -- works with all backends)
  -b, --backend <name>                Backend display name (e.g., grok, openai, claude)
  -u, --base-url <url>                API base URL (or set GROK_BASE_URL env var)
  -m, --model <model>                 AI model to use (e.g., grok-code-fast-1, grok-4-latest) (or set GROK_MODEL env
                                      var)
  -t, --temperature <temp>            temperature for API requests (0.0-2.0, default: 0.7) (default: "0.7")
  --max-tokens <tokens>               maximum tokens for API responses (positive integer, no default = API default)
  -p, --prompt [prompt]               process a single prompt and exit (headless mode).  If no prompt provided, reads
                                      from stdin
  --max-tool-rounds <rounds>          maximum number of tool execution rounds (default: 400) (default: "400")
  --fresh                             start with a fresh session (don't load previous chat history)
  --auto-approve                      auto-approve all operations without confirmation prompts
  --auto-approve-commands <commands>  comma-separated list of commands to auto-approve (e.g.,
                                      'chdir,list_files,pwd')
  -c, --context <file>                path to context persistence file (default: ~/.zds-ai/context.json)
  --no-ink                            disable Ink UI and use plain console input/output
  --debug-log <file>                  redirect MCP server debug output to log file instead of suppressing
  --show-all-tools                    list all available tools (internal and MCP) and exit
  --show-context-stats                display token usage stats for the specified context file and exit
  -h, --help                          display help for command

```

### Custom Instructions

> **Note**: Custom instructions still use the legacy `.grok/` directory paths (not `.zds-ai/`).  This is for backwards compatibility with the original fork.

You can provide custom instructions to tailor zai-cli's behavior by creating `GROK.md` files in two locations:

- **Global instructions** (apply to all projects): `~/.grok/GROK.md`
- **Project-specific instructions** (apply only to the current project): `.grok/GROK.md` in your project directory

Global instructions are loaded first, followed by project-specific instructions.  If both exist, they are combined in that order.

To create project-specific instructions:

```sh
mkdir .grok

```

Create `.grok/GROK.md` with your custom instructions:

```markdown

# Custom Instructions for zai-cli

- Always use TypeScript for any new code files.
- When creating React components, use functional components with hooks.
- Prefer const assertions and explicit typing over inference where it improves clarity.
- Always add JSDoc comments for public functions and interfaces.
- Follow the existing code style and patterns in this project.

```

zai-cli will automatically load and follow these instructions when working in your project directory.  The custom instructions are added to zai-cli's system prompt and take priority over default behavior.

## Morph Fast Apply (Optional)

zai-cli supports Morph's Fast Apply model for high-speed code editing at **4,500+ tokens/sec with 98% accuracy**.  This is an optional feature that provides lightning-fast file editing capabilities.

**Setup**: Configure your Morph API key following the [setup instructions](#setup) above.

### How It Works

When `MORPH_API_KEY` is configured:
- **`edit_file` tool becomes available** alongside the standard `str_replace_editor`
- **Optimized for complex edits**: Use for multi-line changes, refactoring, and large modifications
- **Intelligent editing**: Uses abbreviated edit format with `// ... existing code ...` comments
- **Fallback support**: Standard tools remain available if Morph is unavailable

**When to use each tool:**
- **`edit_file`** (Morph): Complex edits, refactoring, multi-line changes
- **`str_replace_editor`**: Simple text replacements, single-line edits

### Example Usage

With Morph Fast Apply configured, you can request complex code changes:

```sh
zai-cli --prompt "refactor this function to use async/await and add error handling"
zai-cli -p "convert this class to TypeScript and add proper type annotations"

```

The AI will automatically choose between `edit_file` (Morph) for complex changes or `str_replace_editor` for simple replacements.

## MCP Tools

zai-cli supports MCP (Model Context Protocol) servers, allowing you to extend the AI assistant with additional tools and capabilities.

### Adding MCP Tools

#### Add a custom MCP server:

```sh

# Add an stdio-based MCP server

zai-cli mcp add my-server --transport stdio --command "bun" --args server.js

# Add an HTTP-based MCP server

zai-cli mcp add my-server --transport http --url "http://localhost:3000"

# Add with environment variables

zai-cli mcp add my-server --transport stdio --command "python" --args "-m" "my_mcp_server" --env "API_KEY=your_key"

```

#### Add from JSON configuration:

```sh
zai-cli mcp add-json my-server '{"command": "bun", "args": ["server.js"], "env": {"API_KEY": "your_key"}}'

```

### Linear Integration Example

To add Linear MCP tools for project management:

```sh

# Add Linear MCP server

zai-cli mcp add linear --transport sse --url "https://mcp.linear.app/sse"

```

This enables Linear tools like:
- Create and manage Linear issues
- Search and filter issues
- Update issue status and assignees
- Access team and project information

### Managing MCP Servers

```sh

# List all configured servers

zai-cli mcp list

# Test server connection

zai-cli mcp test server-name

# Remove a server

zai-cli mcp remove server-name

```

### Available Transport Types

- **stdio**: Run MCP server as a subprocess (most common)
- **http**: Connect to HTTP-based MCP server
- **sse**: Connect via Server-Sent Events

## Hooks System

zai-cli includes a powerful hooks system for customizing behavior at various points in the execution lifecycle.  Hooks are shell commands that can modify context, set variables, or control execution flow.

### Configuring Hooks

Add hooks to `~/.zds-ai/cli-settings.json` or `.zds-ai/project-settings.json`:

```json
{
  "startupHook": "echo 'Session started'",
  "instanceHook": "/path/to/script.sh",
  "personaHook": "validate-persona.sh",
  "personaHookMandatory": true
}

```

### Available Hooks

**Lifecycle Hooks:**
- `startupHook` - Runs at session start, output added to system prompt
- `instanceHook` - Runs for every instance (new and resumed sessions)

**Operation Hooks:**
- `postUserInputHook` - Runs after user input received
- `preLLMResponseHook` - Runs before prompt sent to LLM
- `postLLMResponseHook` - Runs after LLM response
- `preToolCallHook` - Runs before tool execution
- `postToolCallHook` - Runs after tool execution

**Validation Hooks:**
- `taskApprovalHook` - Validates task operations (start/transition/stop)
- `toolApprovalHook` - Validates tool execution before running
- `personaHook` - Validates persona changes
- `moodHook` - Validates mood changes

**Context Helpers:**
- `contextViewHelper` / `contextViewHelperGui` - Custom context viewing
- `contextEditHelper` / `contextEditHelperGui` - Custom context editing

### Hook Commands

Hooks can output special commands to control the CLI:

```sh

# Set environment variables

ENV VAR_NAME=value

# Set prompt variables

SET VAR:NAME=value
SET_FILE VAR:NAME=/path/to/file

# Add system messages

SYSTEM This message appears in the system prompt

# Test backend configurations (persona/mood hooks)

TEST_BACKEND backend_name base_url model api_key_env_var

# Model/backend selection

MODEL model_name
BACKEND backend_name
BASE_URL https://api.example.com/v1
API_KEY_ENV_VAR ENV_VAR_NAME

```

## Personas and Moods

Customize the AI's behavior and context with personas and moods.

### Using Personas

```sh

# Set persona

/persona debugging red
/persona architect blue

# With hook validation (if personaHook configured)

/persona production-review yellow

```

Personas can:
- Change the AI's behavior and focus
- Switch backends/models via hooks
- Set environment variables
- Add context to the system prompt

### Using Moods

```sh

# Set mood

/mood focused green
/mood exploratory purple

```

Moods provide additional behavioral context without changing the fundamental persona.

### Configuring Persona/Mood Hooks

```json
{
  "personaHook": "persona-validator.sh",
  "personaHookMandatory": true,
  "moodHook": "mood-setter.sh",
  "moodHookMandatory": false
}

```

Hook validation can switch backends, set variables, or reject invalid personas/moods.

## Active Tasks

Track and manage active tasks with documentation support.

### Task Commands

```sh

# Start a task

/task start "Implement feature X" "designing" blue

# Update task status

/task status "implementing" yellow

# Stop task and document

/task stop "Feature complete" docs/feature-x.md green

```

### Task Tool Usage

The AI can also manage tasks via tools:
- `startActiveTask(name, action, color)` - Begin tracking a task
- `transitionActiveTaskStatus(action, color)` - Update task status
- `stopActiveTask(reason, documentationFile, color)` - Complete and document task

Tasks persist across sessions and appear in the system prompt.

## Session Persistence

zai-cli automatically saves and restores session state between runs.

### What Gets Saved

- Chat history
- Active persona and mood
- Current task
- Backend and model selection
- Working directory
- Prompt variables
- System prompt

### Session Management

```sh

# Start fresh session (ignore saved state)

zai-cli --fresh

# View current context

/context

# Edit context manually

/context edit

# Reload context from file

/context reload

# Compact context (keep last 20 messages)

/compact

```

Context is automatically saved to `~/.zds-ai/context.json`

## Slash Commands Reference

### Help and Information

- `/?` - Introspect tools and environment (alias for `/introspect`)
- `/help` - Show command help
- `/introspect` - List all available tools and environment info

### History Management

- `/clear` - Clear chat history (current session + persisted)
- `/compact` - Reduce context size (keep last 20 messages)

### Context Operations

- `/context` - Show context usage info
- `/context view` - View full context in pager (markdown format)
- `/context edit` - Edit context JSON file (opens in $EDITOR)
- `/context reload` - Reload context from file immediately

### Model and Backend

- `/models` - Interactive model selection menu
- `/models <model>` - Switch to specific model directly

### State Management

- `/persona <text> [color]` - Set current persona
- `/mood <text> [color]` - Set current mood

### Response Control

- `/rephrase [text]` - Request rephrasing of last response
- `/system rephrase [text]` - Same as /rephrase but as system message

### UI Control

- `/ink` - Switch to Ink UI mode (restart required)
- `/no-ink` - Switch to plain console mode (restart required)

### Session Control

- `/restart` - Restart the application (exit code 51)
- `/exit` or `exit` or `quit` - Exit application

## Development

```sh

# Install dependencies

bun install

# Development mode

bun run dev

# Build project

bun run build

# Run linter

bun run lint

# Type check

bun run typecheck

```

## Architecture

- **Agent**: Core command processing and execution logic
- **Tools**: Text editor and bash tool implementations
- **UI**: Ink-based terminal interface components
- **Types**: TypeScript definitions for the entire system

## License

MIT
