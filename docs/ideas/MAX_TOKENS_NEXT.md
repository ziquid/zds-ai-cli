# MAX_TOKENS_NEXT - One-Time Response Length Override

## Use Case

Approval hooks (toolApprovalHook, taskApprovalHook) may need to limit response length for a single response without persisting the limit for the entire session.

**Example Scenario:**
- User asks AI to perform a complex task that requires tool execution
- Tool approval hook determines this specific response should be brief (e.g., status update only)
- Hook sets `MAX_TOKENS_NEXT=200` for this response only
- Next user message returns to normal token limits (no manual reset needed)

**Why Not ENV MAX_TOKENS?**
`ENV MAX_TOKENS=400` persists for the entire session.  While this works for Discord (each message = new session), it doesn't work for:
- Interactive sessions where one response needs limiting but others don't
- Approval hooks that want to constrain specific tool responses
- Context-dependent overrides (e.g., "status check" vs "detailed explanation")

## Implementation

### 1. Environment Variable

Hooks output:
```bash
echo "ENV MAX_TOKENS_NEXT=400"
```

This sets `process.env.ZDS_AI_AGENT_MAX_TOKENS_NEXT="400"` via hook-executor.ts.

### 2. Settings Manager (src/utils/settings-manager.ts)

Update `getMaxTokens()` method to check `MAX_TOKENS_NEXT` first:

```typescript
public getMaxTokens(): number | undefined {
  // Check one-time override first (cleared after each response)
  const nextMaxTokens = process.env.ZDS_AI_AGENT_MAX_TOKENS_NEXT;
  if (nextMaxTokens) {
    const parsed = parseInt(nextMaxTokens);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Check user settings
  const settingsMaxTokens = this.getUserSetting("maxTokens");
  if (settingsMaxTokens !== undefined && Number.isInteger(settingsMaxTokens) && settingsMaxTokens > 0) {
    return settingsMaxTokens;
  }

  // Check persistent environment variable (set by instance hook for Discord)
  const envMaxTokens = process.env.ZDS_AI_AGENT_MAX_TOKENS;
  if (envMaxTokens) {
    const parsed = parseInt(envMaxTokens);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined; // No default - let API decide
}
```

### 3. GrokAgent (src/agent/llm-agent.ts)

Clear `MAX_TOKENS_NEXT` after each response completes:

```typescript
// In processUserMessage() - after response completes, before return
delete process.env.ZDS_AI_AGENT_MAX_TOKENS_NEXT;
return response;

// In processUserMessageStream() - after streaming completes, before return
delete process.env.ZDS_AI_AGENT_MAX_TOKENS_NEXT;
return;
```

**Important:** Clear AFTER response generation completes, not before.  The variable must be available during the API call.

### 4. Priority Order

Final priority order for max_tokens:

1. `--max-tokens` CLI argument (entire session)
2. `ZDS_AI_AGENT_MAX_TOKENS_NEXT` environment variable (next response only, auto-cleared)
3. User settings `maxTokens` in ~/.grok/user-settings.json (entire session)
4. `ZDS_AI_AGENT_MAX_TOKENS` environment variable (persistent, set by instance hook)
5. `GROK_MAX_TOKENS` environment variable (legacy, in GrokClient only)
6. API default (1536 or API-specific default)

## Hook Examples

### Tool Approval Hook - Limit Status Responses
```bash
#!/usr/bin/env zsh
# Only allow brief responses for status check tools

if [[ "$ZDS_AI_AGENT_TOOL_NAME" == "gitStatus" || "$ZDS_AI_AGENT_TOOL_NAME" == "pwdir" ]]; then
  echo "ENV MAX_TOKENS_NEXT=100"
  echo "SYSTEM Keep this response to one sentence only."
  exit 0
fi

exit 0
```

### Task Approval Hook - Limit Non-Coding Tasks
```bash
#!/usr/bin/env zsh
# Brief responses for non-coding tasks

if [[ "$ZDS_AI_AGENT_OPERATION" == "task_start" ]]; then
  ACTION="$ZDS_AI_AGENT_PARAM_TASK_ACTION"

  # Limit tokens for planning/researching, allow full responses for coding
  if [[ "$ACTION" == "planning" || "$ACTION" == "researching" ]]; then
    echo "ENV MAX_TOKENS_NEXT=300"
  fi
fi

exit 0
```

## Testing

1. Start zai-cli session
2. Configure hook to set `ENV MAX_TOKENS_NEXT=100`
3. Trigger the hook (execute tool or start task)
4. Verify response is limited to ~100 tokens
5. Send another message (without triggering hook)
6. Verify response is NOT limited (uses normal limits)

## Notes

- `MAX_TOKENS_NEXT` is cleared automatically after each response
- No manual cleanup needed
- Works with both streaming and non-streaming responses
- Compatible with existing `MAX_TOKENS` persistent override
- Hook can set both `MAX_TOKENS` (persistent) and `MAX_TOKENS_NEXT` (one-time) if needed
