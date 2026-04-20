import OpenAI from "openai";
import type { LLMMessage, LLMTool, LLMResponse, LLMToolCall, SearchOptions } from "./client.js";
import { ChatHistoryManager } from "../utils/chat-history-manager.js";
import { logApiError } from "../utils/error-logger.js";
import fs from "fs";

/**
 * LLM client targeting xAI's native Responses API (/v1/responses).
 *
 * Dual-client pattern: coexists with the existing LLMClient (Chat Completions).
 * Selected when GROK_USE_RESPONSES_API=true and backend is grok.
 *
 * Key differences from Chat Completions:
 * - Uses `input` array instead of `messages`; tool results are `function_call_output` items
 * - Tool call output items have `call_id` for result correlation
 * - Streaming uses SSE events (response.output_text.delta, response.function_call_arguments.delta, etc.)
 * - Supports stateful conversation continuation via `previous_response_id` (future opt.)
 */
export class GrokResponsesClient {
  private client: OpenAI;
  private currentModel: string;
  private backendName: string = "grok";
  private supportsTools: boolean = true;
  private supportsVision: boolean = true;
  private disableReasoningOverride: boolean = false;
  private defaultMaxTokens: number;

  constructor(apiKey: string, model?: string, baseURL?: string, displayName?: string) {
    const finalBaseURL = baseURL || process.env.GROK_BASE_URL || "https://api.x.ai/v1";
    this.client = new OpenAI({
      apiKey,
      baseURL: finalBaseURL,
      timeout: 360000,
    });
    const envMax = Number(process.env.GROK_MAX_TOKENS);
    this.defaultMaxTokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 1536;
    this.currentModel = model || "grok-3-mini";

    if (displayName) {
      this.backendName = displayName;
    }

    if (this.currentModel.endsWith(":nothinking")) {
      this.currentModel = this.currentModel.slice(0, -":nothinking".length);
      this.disableReasoningOverride = true;
    }
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  getBaseURL(): string {
    return (this.client as any).baseURL || "https://api.x.ai/v1";
  }

  getBackendName(): string {
    return this.backendName;
  }

  getSupportsTools(): boolean {
    return this.supportsTools;
  }

  getSupportsVision(): boolean {
    return this.supportsVision;
  }

  setSupportsVision(value: boolean): void {
    this.supportsVision = value;
  }

  async setModel(model: string): Promise<void> {
    if (model.endsWith(":nothinking")) {
      this.currentModel = model.slice(0, -":nothinking".length);
      this.disableReasoningOverride = true;
    } else {
      this.currentModel = model;
      this.disableReasoningOverride = false;
    }
    this.supportsTools = true;
    this.supportsVision = true;
  }

  /**
   * Convert Chat Completions messages array to Responses API input items.
   * - role:tool → { type: "function_call_output", call_id, output }
   * - role:assistant with tool_calls → { type: "function_call", ... } items
   * - everything else → { role, content } EasyInputMessage
   */
  private messagesToInput(messages: LLMMessage[]): any[] {
    const input: any[] = [];
    for (const msg of messages) {
      const m = msg as any;
      if (m.role === "tool") {
        input.push({
          type: "function_call_output",
          call_id: m.tool_call_id,
          output: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
        });
      } else if (m.role === "assistant" && m.tool_calls?.length) {
        // Assistant content comes before the tool calls
        if (m.content) {
          input.push({ role: "assistant", content: m.content });
        }
        for (const tc of m.tool_calls) {
          input.push({
            type: "function_call",
            id: tc.id,
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else {
        // system / user / plain assistant
        const content = m.content;
        if (this.supportsVision || !Array.isArray(content)) {
          input.push({ role: m.role, content });
        } else {
          // Strip image content if vision not supported
          const textOnly = content.filter((c: any) => c.type === "text");
          input.push({ role: m.role, content: textOnly.length > 0 ? textOnly[0].text : "" });
        }
      }
    }
    return input;
  }

  /**
   * Convert Responses API output items into a Chat-Completions-compatible LLMResponse.
   */
  private outputToLLMResponse(output: any[]): LLMResponse {
    let textContent = "";
    const toolCalls: LLMToolCall[] = [];

    for (const item of output) {
      if (item.type === "message") {
        for (const c of item.content || []) {
          if (c.type === "output_text" || c.type === "text") {
            textContent += c.text;
          }
        }
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id || item.id,
          type: "function",
          function: {
            name: item.name,
            arguments: item.arguments,
          },
        });
      }
    }

    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: textContent || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
    };
  }

  private readonly MAX_TOOLS = 200;

  /** Convert LLMTool array to Responses API function tool format. */
  private toResponsesTools(tools: LLMTool[]): any[] {
    return tools.slice(0, this.MAX_TOOLS).map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  async chat(
    messages: LLMMessage[],
    tools?: LLMTool[],
    model?: string,
    _searchOptions?: SearchOptions,
    _temperature?: number,
    signal?: AbortSignal,
    maxTokens?: number
  ): Promise<LLMResponse> {
    const modelToUse = model || this.currentModel;
    const input = this.messagesToInput(messages);

    const params: any = {
      model: modelToUse,
      input,
      max_output_tokens: maxTokens ?? this.defaultMaxTokens,
    };

    if (this.supportsTools && tools?.length) {
      params.tools = this.toResponsesTools(tools);
    }

    const debugLogPath = ChatHistoryManager.getDebugLogPath();
    fs.appendFileSync(
      debugLogPath,
      `${new Date().toISOString()} - RESPONSES API CALL: model=${modelToUse}, input_items=${input.length}\n`
    );

    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await (this.client.responses as any).create(params, { signal });
        return this.outputToLLMResponse(response.output || []);
      } catch (error: any) {
        if (error.status === 400 && error.message?.toLowerCase().includes("does not support tools")) {
          this.supportsTools = false;
          delete params.tools;
          continue;
        }

        if (error.status === 500) {
          const { requestFile, responseFile } = await logApiError(
            params,
            error,
            { errorType: "runtime-api-error" },
            "500"
          );
          throw new Error(
            `${this.backendName} Responses API error: ${error.message}\nRequest logged to: ${requestFile}\nResponse logged to: ${responseFile}`
          );
        }

        const is429 =
          error.status === 429 ||
          error.code === "rate_limit_exceeded" ||
          (error.message && error.message.toLowerCase().includes("rate limit"));
        if (is429 && attempt < maxRetries) {
          console.error(`Rate limit hit. Retrying in 10s... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, 10000));
          continue;
        }

        throw new Error(`${this.backendName} Responses API error: ${error.message}`);
      }
    }
    throw new Error(`${this.backendName} Responses API error: Max retries exceeded`);
  }

  /**
   * Stream a response from the Responses API, yielding chunks in Chat-Completions-compatible format
   * so the existing llm-agent.ts messageReducer can accumulate them without changes.
   *
   * Mapping:
   *   response.output_text.delta          → choices[0].delta.content
   *   response.output_item.added (fn)     → choices[0].delta.tool_calls[index] header
   *   response.function_call_arguments.delta → choices[0].delta.tool_calls[index].function.arguments
   *   response.completed                  → choices[0].finish_reason = stop|tool_calls
   */
  async *chatStream(
    messages: LLMMessage[],
    tools?: LLMTool[],
    model?: string,
    _searchOptions?: SearchOptions,
    _temperature?: number,
    signal?: AbortSignal,
    maxTokens?: number
  ): AsyncGenerator<any, void, unknown> {
    const modelToUse = model || this.currentModel;
    const input = this.messagesToInput(messages);

    const params: any = {
      model: modelToUse,
      input,
      max_output_tokens: maxTokens ?? this.defaultMaxTokens,
      stream: true,
    };

    if (this.supportsTools && tools?.length) {
      params.tools = this.toResponsesTools(tools);
    }

    const maxRetries = 5;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const stream = await (this.client.responses as any).create(params, { signal });

        // Maps output item id → { index, call_id }
        const toolCallMap = new Map<string, { index: number; callId: string }>();
        let toolCallCount = 0;
        let hasFunctionCalls = false;

        for await (const event of stream) {
          if (signal?.aborted) return;

          switch (event.type) {
            case "response.output_text.delta":
              yield {
                choices: [{ delta: { content: event.delta, role: "assistant" }, finish_reason: null }],
              };
              break;

            case "response.output_item.added": {
              const item = event.item;
              if (item?.type === "function_call") {
                const idx = toolCallCount++;
                const callId = item.call_id || item.id;
                toolCallMap.set(item.id, { index: idx, callId });
                hasFunctionCalls = true;
                // Emit header chunk — messageReducer merges by array index
                yield {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            index: idx,
                            id: callId,
                            type: "function",
                            function: { name: item.name || "", arguments: "" },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                };
              }
              break;
            }

            case "response.function_call_arguments.delta": {
              const entry = toolCallMap.get(event.item_id);
              const idx = entry?.index ?? 0;
              yield {
                choices: [
                  {
                    delta: {
                      tool_calls: [{ index: idx, function: { arguments: event.delta } }],
                    },
                    finish_reason: null,
                  },
                ],
              };
              break;
            }

            case "response.completed":
              yield {
                choices: [{ delta: {}, finish_reason: hasFunctionCalls ? "tool_calls" : "stop" }],
              };
              return;

            case "response.failed":
            case "error":
              throw new Error(
                `${this.backendName} Responses API stream error: ${JSON.stringify(event.error || event)}`
              );
          }
        }
        // Stream ended without response.completed — emit terminal chunk as fallback
        yield {
          choices: [{ delta: {}, finish_reason: hasFunctionCalls ? "tool_calls" : "stop" }],
        };
        return;
      } catch (error: any) {
        if (signal?.aborted) return;

        if (error.status === 400 && error.message?.toLowerCase().includes("does not support tools")) {
          this.supportsTools = false;
          delete params.tools;
          continue;
        }

        const is429 =
          error.status === 429 ||
          error.code === "rate_limit_exceeded" ||
          (error.message && error.message.toLowerCase().includes("rate limit"));
        if (is429 && attempt < maxRetries) {
          console.error(`Rate limit hit. Retrying in 11s... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, 11000));
          continue;
        }

        throw new Error(`${this.backendName} Responses API error: ${error.message}`);
      }
    }
    throw new Error(`${this.backendName} Responses API error: Max retries exceeded`);
  }
}

/**
 * Returns true if the Responses API should be used for this backend/environment.
 * Enable with GROK_USE_RESPONSES_API=true.
 */
export function shouldUseResponsesAPI(backendName: string): boolean {
  return (
    process.env.GROK_USE_RESPONSES_API === "true" &&
    backendName.toLowerCase() === "grok"
  );
}

