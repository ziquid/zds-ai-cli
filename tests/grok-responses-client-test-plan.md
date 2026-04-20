# Test Plan: GrokResponsesClient (Responses API Path)

Covers the xAI Responses API code path (`/v1/responses`) activated when
`GROK_USE_RESPONSES_API=true` and the backend display name is `grok`.

## Prerequisites

- `zai-cli` built from `dev` branch (`mzke build` or `bun run build`)
- Valid xAI API key set in the appropriate backend env var (e.g., `XAI_API_KEY`)
- `GROK_USE_RESPONSES_API=true`
- `GROK_BACKEND_DISPLAY_NAME=grok` (required -- `shouldUseResponsesAPI()` checks `backendName.toLowerCase() === "grok"`)
- `GROK_BASE_URL` set if not using default `https://api.x.ai/v1`
- Optional: `GROK_MAX_TOKENS` (defaults to 1536)

Invoke directly as `zai-cli` (not `zai`, which is the shell wrapper).

## 1. Verify Client Selection

- [ ] Run `zai-cli --debug` with the above env vars
- [ ] Confirm debug log shows `GrokResponsesClient` is in use (not `LLMClient`)

## 2. Basic Interactive Chat

- [ ] Start `zai-cli` in interactive mode
- [ ] Send a simple text message (e.g., "Hello, what is 2+2?")
- [ ] Verify a coherent response is returned
- [ ] Verify no errors in debug log

## 3. Streaming Chat

- [ ] Start `zai-cli` in interactive mode with streaming enabled
- [ ] Send a message and verify tokens stream incrementally
- [ ] Verify the final accumulated response is coherent and complete

## 4. Tool Calls

- [ ] Send a message that triggers a tool call (e.g., "List the files in the current directory")
- [ ] Verify the tool call executes and the result is returned to the LLM
- [ ] Verify `call_id` correlation works (tool result maps back to the correct tool call)
- [ ] Verify multi-round tool calls work (LLM calls a tool, gets result, calls another tool)

## 5. Headless Mode (`--prompt`)

- [ ] Run `zai-cli --prompt "What is 2+2?"` with the Responses API env vars set
- [ ] Verify output is printed to stdout and process exits 0
- [ ] Run a headless invocation that triggers tool calls
- [ ] Verify tool calls execute and final response is returned

## 6. Message Format Verification

- [ ] With `--debug`, verify the API request uses `input` array (not `messages`)
- [ ] Verify tool results are sent as `function_call_output` items with `call_id`
- [ ] Verify system messages are included in the `input` array correctly

## 7. Error Handling

- [ ] Test with an invalid API key -- verify a clear error message (not a crash)
- [ ] Test rate limiting behavior (if possible) -- verify retry logic (10s/11s backoff)
- [ ] Test with a model that doesn't support tools -- verify graceful fallback (`supportsTools` set to false)

## 8. Backend Switching

- [ ] Start with a non-grok backend, switch to grok mid-session via hook
- [ ] Verify `shouldUseResponsesAPI()` correctly selects `GrokResponsesClient` vs `LLMClient`
- [ ] Verify switching back to a non-grok backend works

## 9. Negative Tests

- [ ] Set `GROK_USE_RESPONSES_API=false` (or unset) -- verify `LLMClient` is used instead
- [ ] Set `GROK_USE_RESPONSES_API=true` with a non-grok `GROK_BACKEND_DISPLAY_NAME` -- verify `LLMClient` is used

## Notes

- Introduced in PR #115
- `shouldUseResponsesAPI()` checks both `GROK_USE_RESPONSES_API === "true"` AND `backendName.toLowerCase() === "grok"`
- Requires live xAI API key -- cannot be tested in CI without mocking
