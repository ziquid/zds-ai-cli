# Grok-CLI Architecture Reference

## Project Structure

```
src/
├── agent/           # Core agent logic
├── grok/           # Grok API client and tool definitions
├── mcp/            # Model Context Protocol integration
├── tools/          # Tool implementations
├── ui/             # Ink-based UI components
├── hooks/          # React hooks for UI behavior
├── utils/          # Utility functions
└── index.ts        # Entry point and CLI argument parsing
```

## Adding a New Tool

### 1. Create Tool Class (`src/tools/your-tool.ts`)

```typescript
import { ToolResult } from "../types";
import { ToolDiscovery } from "./tool-discovery";

export class YourTool implements ToolDiscovery {
  private agent: any; // Reference to GrokAgent if needed

  setAgent(agent: any) {
    this.agent = agent;
  }

  // REQUIRED for tool discovery in /introspect
  getHandledToolNames(): string[] {
    return ["yourMethod"];
  }

  async yourMethod(param: string): Promise<ToolResult> {
    return {
      success: true,
      output: "Result",
      displayOutput: "Short result" // Optional, shown to user
    };
  }
}
```

### 2. Export Tool (`src/tools/index.ts`)

```typescript
export { YourTool } from "./your-tool";
```

### 3. Add to Agent (`src/agent/llm-agent.ts`)

**Import:**
```typescript
import {
  // ... other tools
  YourTool
} from "../tools";
```

**Property:**
```typescript
private yourTool: YourTool;
```

**Constructor:**
```typescript
this.yourTool = new YourTool();
this.yourTool.setAgent(this); // If tool needs agent access
```

**executeTool method:**
```typescript
case "yourMethod":
  return await this.yourTool.yourMethod(args.param);
```

### 4. Define Tool Schema (`src/grok/tools.ts`)

Add to the exported array:

```typescript
{
  type: "function",
  function: {
    name: "yourMethod",
    description: "What this tool does",
    parameters: {
      type: "object",
      properties: {
        param: {
          type: "string",
          description: "Parameter description",
        },
      },
      required: ["param"],
    },
  },
}
```

**IMPORTANT**: Tool definitions in `src/grok/tools.ts` must match the method signatures in your tool class.

## Adding Status Bar Widgets

### Widget Types

**Standard Widget (with color)**
- Examples: Persona, Mood
- Properties: value, color
- Event data: `{ value: string; color: string }`

**Active Task Widget (with action/reason)**
- Properties: activeTask, action, color
- Event data: `{ activeTask: string; action: string; color: string }`
- Actions (when active): researching, planning, coding, documenting, testing
- Reasons (when transitioning): finished, blocked, error, preempted
- Implicit tasks: chatting, learning, resting
- Display: `📋 action: task` or `📋 task` (if no action)

### 1. Create Widget Component (`src/ui/components/your-status.tsx`)

```typescript
import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { GrokAgent } from "../../agent/grok-agent";

interface YourStatusProps {
  agent?: GrokAgent;
}

export function YourStatus({ agent }: YourStatusProps) {
  const [value, setValue] = useState<string>("");
  const [color, setColor] = useState<string>("white");

  useEffect(() => {
    if (!agent) return;

    // Get initial value
    setValue(agent.getYourValue());
    setColor(agent.getYourColor());

    // Listen for changes
    const handleChange = (data: { value: string; color: string }) => {
      setValue(data.value);
      setColor(data.color);
    };

    agent.on('yourChange', handleChange);

    return () => {
      agent.off('yourChange', handleChange);
    };
  }, [agent]);

  if (!agent || !value) {
    return null;
  }

  return (
    <Box marginLeft={1}>
      <Text color={color as any}>
        {value}
      </Text>
    </Box>
  );
}
```

### 2. Add to Chat Interface (`src/ui/components/chat-interface.tsx`)

**Import:**
```typescript
import { YourStatus } from "./your-status";
```

**Add to status bar (around line 410):**
```typescript
<MCPStatus />
<ContextStatus agent={agent} />
<PersonaStatus agent={agent} />
<MoodStatus agent={agent} />
<YourStatus agent={agent} />  {/* Add here */}
```

### 3. Add Agent State and Methods (`src/agent/llm-agent.ts`)

**Properties:**
```typescript
private yourValue: string = "";
private yourColor: string = "white";
```

**Getters:**
```typescript
getYourValue(): string {
  return this.yourValue;
}

getYourColor(): string {
  return this.yourColor;
}
```

**Setter with event emission:**
```typescript
setYourValue(value: string, color?: string): void {
  this.yourValue = value;
  this.yourColor = color || "white";
  this.emit('yourChange', {
    value: this.yourValue,
    color: this.yourColor
  });
}
```

## Adding Slash Commands

Location: `src/hooks/use-input-handler.ts`

### 1. Add to Command Suggestions (around line 251)

```typescript
const commandSuggestions: CommandSuggestion[] = [
  { command: "/help", description: "Show help information" },
  // ...
  { command: "/yourcommand", description: "What it does" },
];
```

### 2. Add Command Handler (in handleSubmit function, around line 440)

```typescript
if (trimmedInput.startsWith("/yourcommand")) {
  const parts = trimmedInput.split(" ");

  // Parse arguments
  const arg1 = parts[1];
  const arg2 = parts[2];

  // Call agent method
  agent.yourMethod(arg1, arg2);

  // Show confirmation
  const confirmEntry: ChatEntry = {
    type: "assistant",
    content: `Command executed: ${arg1}`,
    timestamp: new Date(),
  };
  setChatHistory((prev) => [...prev, confirmEntry]);
  clearInput();
  return true;
}
```

## Command-Line Flags

Location: `src/index.ts`

### Adding a New Flag

**1. Add option (around line 377):**
```typescript
program
  .option("--your-flag", "Description of your flag")
  .action(async (message, options) => {
    // ...
  });
```

**2. Handle flag (in action handler, around line 444):**
```typescript
if (options.yourFlag) {
  await handleYourFlag();
  process.exit(0);
}
```

## Event System

The agent extends EventEmitter. Use this pattern for reactive UI updates:

**Emit from agent:**
```typescript
this.emit('eventName', { data: value });
```

**Listen in React component:**
```typescript
useEffect(() => {
  if (!agent) return;

  const handleEvent = (data) => {
    setState(data);
  };

  agent.on('eventName', handleEvent);

  return () => {
    agent.off('eventName', handleEvent);
  };
}, [agent]);
```

## File Locations Quick Reference

| What | Where |
|------|-------|
| Tool implementations | `src/tools/*.ts` |
| Tool exports | `src/tools/index.ts` |
| Tool schemas for LLM | `src/grok/tools.ts` |
| Tool execution router | `src/agent/llm-agent.ts` (executeTool method) |
| Slash commands | `src/hooks/use-input-handler.ts` |
| Status bar widgets | `src/ui/components/*-status.tsx` |
| Status bar layout | `src/ui/components/chat-interface.tsx` (around line 410) |
| CLI flags | `src/index.ts` (program options) |
| Agent state/methods | `src/agent/llm-agent.ts` |

## Build and Install

```sh
cd /path/to/zai-cli
mzke build    # Compiles TypeScript
mzke prig     # Package Remove and Install Globally
```

## Testing Tools

```sh
zai-cli                                 # Start interactive mode
zai-cli "your message"                  # Send single message
zai-cli --show-all-tools                # List all tools
zai-cli --show-context-stats            # Show token usage
zai-cli --show-context-stats -c FILE    # Show token usage for specific context file
```

Inside zai-cli:
- `/introspect tools` - List all tools
- `/introspect tool:toolName` - Show tool schema
- `/help` - Show help

## Common Patterns

### Tool that modifies agent state:
1. Tool calls `this.agent.setSomething()`
2. Agent's setter emits event
3. UI component listens for event and updates

### Tool that doesn't need agent access:
1. Just implement the method
2. Don't call `setAgent()` or store agent reference
3. Return ToolResult

### Tool that needs context awareness:
1. Add `private agent: any;` property
2. Implement `setAgent(agent: any) { this.agent = agent; }`
3. In agent constructor, call `this.yourTool.setAgent(this);`
4. Access context with `this.agent.getContextUsagePercent()`

Example: Limiting output based on context usage:
```typescript
export class YourTool implements ToolDiscovery {
  private agent: any;

  setAgent(agent: any) {
    this.agent = agent;
  }

  async yourMethod(): Promise<ToolResult> {
    const contextPercent = this.agent?.getContextUsagePercent() || 0;

    // Disable at 95%+
    if (contextPercent >= 95) {
      return {
        success: false,
        error: "Tool disabled at high context usage. Clear cache first."
      };
    }

    // Limit output based on context
    let maxSize = 20000; // default
    if (contextPercent >= 90) maxSize = 2000;
    else if (contextPercent >= 80) maxSize = 10000;

    // Use maxSize to limit your output
    // ...
  }
}
```

### Slash command that calls tool:
- Parse arguments
- Call `agent.toolMethod(args)`
- Show confirmation message
- Return true

### Status widget that's always visible:
- Don't check `if (!value)` before render
- Always return the Box

### Status widget that conditionally shows:
- Check `if (!value)` and `return null`
- Widget disappears when empty

## Context Management

### Approximate Token Estimation
Use ~4 characters per token as a rough estimate:
- 20k tokens ≈ 80,000 characters
- 10k tokens ≈ 40,000 characters
- 2k tokens ≈ 8,000 characters

### Context Usage Thresholds
From agent: `agent.getContextUsagePercent()`

Standard limits for tools that load large content:
- **< 80%**: Normal operation, 20k token limit
- **80-89%**: Reduced capacity, 10k token limit
- **90-94%**: Critical, 2k token limit only
- **≥ 95%**: Disable heavy operations entirely

### Example: viewFile Implementation
See `src/tools/text-editor.ts` for full example of context-aware limiting

## Active Task Management

### Overview
The active task system tracks the current task the LLM is working on, displays it in the status bar, and enforces business logic around task lifecycle. It includes external hook validation for task operations.

### Three-Method Pattern

**1. startActiveTask** - Start a new task
- **Business Rule**: Cannot start if active task already exists
- **Parameters**: `activeTask` (string), `action` (string), `color?` (string)
- **Hook**: `startActiveTaskHook` from user settings
- **Hook Args**: `[activeTask, action, color]`

**2. transitionActiveTaskStatus** - Change status of current task
- **Business Rule**: Cannot transition if no active task
- **Parameters**: `action` (string), `color?` (string)
- **Hook**: `transitionActiveTaskStatusHook` from user settings
- **Hook Args**: `[activeTask, oldAction, newAction, color]`
- **Note**: Task name stays the same, only action/color changes

**3. stopActiveTask** - Stop current task with documentation proof
- **Business Rule**: Cannot stop if no active task
- **Parameters**: `reason` (string), `documentationFile` (string), `color?` (string)
- **Hook**: `stopActiveTaskHook` from user settings
- **Hook Args**: `[activeTask, action, reason, documentationFile, color]`
- **Special**: Minimum 3-second delay from call time before clearing task

### Actions and Reasons

**Active actions**: researching, planning, coding, documenting, testing, chatting, learning, resting

**Transition reasons**: finished, blocked, error, preempted

The LLM can use any action/reason - these are guidelines, not restrictions.

### Hook Validation System

Hooks are optional external scripts configured in `~/.grok/user-settings.json`:

```json
{
  "startActiveTaskHook": "/path/to/validate-start.sh",
  "transitionActiveTaskStatusHook": "/path/to/validate-transition.sh",
  "stopActiveTaskHook": "/path/to/validate-stop.sh"
}
```

**Hook Behavior**:
- **Exit code 0**: Approved - operation proceeds
- **Exit code >0**: Rejected - operation fails, stdout captured as reason
- **Timeout (30s)**: Auto-approved - operation proceeds

**Implementation**: See `src/utils/hook-executor.ts` for the `executeHook()` utility.

### Agent State
Located in `src/agent/llm-agent.ts`:

```typescript
private activeTask: string = "";
private activeTaskAction: string = "";
private activeTaskColor: string = "white";
```

**Getters**:
- `getActiveTask()`
- `getActiveTaskAction()`
- `getActiveTaskColor()`

### Event System
Widget updates via EventEmitter pattern:

```typescript
this.emit('activeTaskChange', {
  activeTask: this.activeTask,
  action: this.activeTaskAction,
  color: this.activeTaskColor
});
```

Widget listens to these events for real-time updates.

### System Messages
All task operations add system messages for recordkeeping:

```typescript
// Start
`Assistant changed task status for "${activeTask}" to ${action} (${color})`

// Transition
`Assistant changed task status for "${activeTask}" from ${oldAction} to ${newAction} (${color})`

// Stop
`Assistant stopped task "${activeTask}" (was ${action}) with reason: ${reason} (${color})`
```

Colors only shown if specified and not "white".

### UI Widget
Located at `src/ui/components/active-task-status.tsx`:

**Display**: `📋 action: task` (max 50 chars)

**Behavior**: Only shows when activeTask is set, disappears when cleared

**Integration**: Added to status bar in `src/ui/components/chat-interface.tsx`

### Complete Implementation Files

**Tool Methods**: `src/tools/character-tool.ts`
- `startActiveTask(activeTask, action, color?)`
- `transitionActiveTaskStatus(action, color?)`
- `stopActiveTask(reason, documentationFile, color?)`

**Agent Methods**: `src/agent/llm-agent.ts`
- Same signatures as tool methods
- Include business logic enforcement
- Hook validation
- Event emission
- System message generation

**Tool Schemas**: `src/grok/tools.ts`
- Three function definitions for LLM
- Clear descriptions of business rules
- Required vs optional parameters

**Hook Settings**: `src/utils/settings-manager.ts`
- Three new fields in UserSettings interface
- Getter methods for hook paths

**Hook Executor**: `src/utils/hook-executor.ts`
- `executeHook(hookPath, args, timeoutMs)` utility
- Returns `{ approved, reason?, timedOut }` interface
