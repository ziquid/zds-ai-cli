import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat";
import { ChatHistoryManager } from "../utils/chat-history-manager.js";
import { logApiError } from "../utils/error-logger.js";
import fs from "fs";

export type LLMMessage = ChatCompletionMessageParam;

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, any>;
      required: string[];
    };
  };
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * @deprecated Use WebSearchTool with the Agent Tools API instead.
 * The search_parameters field is deprecated as of December 15, 2025.
 */
export interface SearchParameters {
  mode?: "auto" | "on" | "off";
  // sources removed -- let API use default sources to avoid format issues
}

export interface WebSearchTool {
  type: "web_search";
  allowed_domains?: string[];
  excluded_domains?: string[];
  enable_image_understanding?: boolean;
  user_location?: {
    type: "approximate";
    country?: string;
    city?: string;
    region?: string;
    timezone?: string;
  };
}

export interface SearchOptions {
  /** @deprecated Use enable_web_search and web_search_filters instead */
  search_parameters?: SearchParameters;
  enable_web_search?: boolean;
  web_search_filters?: {
    allowed_domains?: string[];
    excluded_domains?: string[];
    enable_image_understanding?: boolean;
    user_location?: {
      type: "approximate";
      country?: string;
      city?: string;
      region?: string;
      timezone?: string;
    };
  };
}

export interface LLMResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: LLMToolCall[];
    };
    finish_reason: string;
  }>;
}

export class LLMClient {
  private client: OpenAI;
  private currentModel: string = "grok-code-fast-1";
  private defaultMaxTokens: number;
  private backendName: string;
  private supportsTools: boolean = true;
  private supportsVision: boolean = true;
  private disableReasoningOverride: boolean = false;

  constructor(apiKey: string, model?: string, baseURL?: string, displayName?: string) {
    const finalBaseURL = baseURL || process.env.GROK_BASE_URL || "https://api.x.ai/v1";
    this.client = new OpenAI({
      apiKey,
      baseURL: finalBaseURL,
      timeout: 360000,
    });
    const envMax = Number(process.env.GROK_MAX_TOKENS);
    this.defaultMaxTokens = Number.isFinite(envMax) && envMax > 0 ? envMax : 1536;
    if (model) {
      // Store the ORIGINAL model name (with suffix) for persistence
      this.currentModel = model;
      // Parse and store the reasoning override flag
      const { disableReasoning } = this.parseModelSuffix(model);
      this.disableReasoningOverride = disableReasoning;
    }

    // Use provided display name, or derive from baseURL hostname as fallback
    if (displayName) {
      this.backendName = displayName;
    } else {
      // Simple fallback: extract hostname from URL
      try {
        const url = new URL(finalBaseURL);
        // Special case: api.x.ai should be "grok" not "x"
        if (url.hostname === 'api.x.ai') {
          this.backendName = 'grok';
        } else {
          this.backendName = url.hostname.replace(/^api\./, '').replace(/\..*$/, '');
        }
      } catch {
        this.backendName = 'AI';
      }
    }
  }

  async setModel(model: string): Promise<void> {
    // Store the ORIGINAL model name (with suffix) for persistence
    this.currentModel = model;
    // Parse and store the reasoning override flag
    const { disableReasoning } = this.parseModelSuffix(model);
    this.disableReasoningOverride = disableReasoning;
    // Reset tool and vision support flags when switching models
    await this.enableTools();
    this.enableVision();
  }

  private parseModelSuffix(model: string): { cleanModel: string; disableReasoning: boolean } {
    const nothinkingSuffix = ':nothinking';
    if (model.endsWith(nothinkingSuffix)) {
      return {
        cleanModel: model.slice(0, -nothinkingSuffix.length),
        disableReasoning: true
      };
    }
    return { cleanModel: model, disableReasoning: false };
  }

  private async enableTools(): Promise<void> {
    if (this.supportsTools) {
      return; // Already enabled
    }

    this.supportsTools = true;

    // Reinitialize MCP servers
    try {
      const { getMCPManager, initializeMCPServers } = await import('../grok/tools.js');
      const { loadMCPConfig } = await import('../mcp/config.js');
      const config = loadMCPConfig();

      if (config.servers.length > 0) {
        await initializeMCPServers();
        console.error(`MCP servers reinitialized.`);
      }
    } catch (mcpError: any) {
      console.warn("MCP reinitialization failed:", mcpError);
    }
  }

  private enableVision(): void {
    if (this.supportsVision) {
      return; // Already enabled
    }

    this.supportsVision = true;
  }

  getCurrentModel(): string {
    return this.currentModel;
  }

  getBaseURL(): string {
    return this.client.baseURL || "https://api.x.ai/v1";
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

  async chat(
    messages: LLMMessage[],
    tools?: LLMTool[],
    model?: string,
    searchOptions?: SearchOptions,
    temperature?: number,
    signal?: AbortSignal,
    maxTokens?: number
  ): Promise<LLMResponse> {
    const maxRetries = 5;
    const retryDelay = 10000; // 10 seconds

    // Parse model suffix (from explicit param or current model)
    const modelToUse = model || this.currentModel;
    const cleanModelName = this.parseModelSuffix(modelToUse).cleanModel;

    // OpenAI detection for parameter compatibility
    const isOpenAI = this.client.baseURL?.includes('openai.com');

    const requestPayload: any = {
      model: cleanModelName,
      messages,
      temperature: temperature ?? 0.7
    };

    // OpenAI models from gpt-5.x, o1, o3, o4-mini onwards require max_completion_tokens
    // instead of max_tokens.  Use max_completion_tokens for these newer models.
    const usesMaxCompletionTokens = isOpenAI && (
      cleanModelName.startsWith('gpt-5') ||
      cleanModelName.startsWith('o1') ||
      cleanModelName.startsWith('o3') ||
      cleanModelName.startsWith('o4-mini')
    );

    if (usesMaxCompletionTokens) {
      requestPayload.max_completion_tokens = maxTokens ?? this.defaultMaxTokens;
    } else {
      requestPayload.max_tokens = maxTokens ?? this.defaultMaxTokens;
    }

    // Build tools array (web_search disabled for Grok -- use Tavily instead)
    const allTools: any[] = [...(tools || [])];

    // DISABLED: Grok web_search temporarily disabled due to API inconsistencies
    // Agents should use Tavily for web search instead
    // if (searchOptions?.enable_web_search && this.client.baseURL?.includes('x.ai')) {
    //   const webSearchTool: any = { type: "web_search" };
    //
    //   if (searchOptions.web_search_filters) {
    //     const filters = searchOptions.web_search_filters;
    //     if (filters.allowed_domains) webSearchTool.allowed_domains = filters.allowed_domains;
    //     if (filters.excluded_domains) webSearchTool.excluded_domains = filters.excluded_domains;
    //     if (filters.enable_image_understanding !== undefined) {
    //       webSearchTool.enable_image_understanding = filters.enable_image_understanding;
    //     }
    //     if (filters.user_location) webSearchTool.user_location = filters.user_location;
    //   }
    //
    //   allTools.push(webSearchTool as any);
    // }
    // // Legacy support for deprecated search_parameters - convert to new Agent Tools API format
    // else if (searchOptions?.search_parameters && this.client.baseURL?.includes('x.ai')) {
    //   // Convert old search_parameters format to new web_search tool format
    //   if (searchOptions.search_parameters.mode === "on" || searchOptions.search_parameters.mode === "auto") {
    //     allTools.push({ type: "web_search" });
    //   }
    //   // mode === "off" means don't add the tool
    // }

    // OpenAI has a hard limit of 128 tools per request
    if (isOpenAI && allTools.length > 128) {
      console.error(`OpenAI tool limit: ${allTools.length} tools exceeds maximum of 128.  Trimming to 128 tools (base tools prioritized over MCP tools).`);
      allTools.splice(128);
    }

    // xAI Grok (Chat Completions path) has a hard limit of 200 tools per request
    const isGrok = this.client.baseURL?.includes('x.ai') || this.backendName.toLowerCase() === 'grok';
    if (isGrok && allTools.length > 200) {
      console.error(`Grok tool limit: ${allTools.length} tools exceeds maximum of 200.  Trimming to 200 tools.`);
      allTools.splice(200);
    }

    // Only include tools if the model supports them AND tools are provided
    if (this.supportsTools && allTools.length > 0) {
      requestPayload.tools = allTools;
      requestPayload.tool_choice = "auto";
    }

    // Only add think parameter for backends that support it (Grok, Ollama)
    const backendLower = this.backendName.toLowerCase();
    const supportsThink = backendLower === 'grok' ||
                          backendLower === 'ollama' ||
                          this.client.baseURL?.includes('x.ai');
    if (supportsThink) {
      requestPayload.think = false;
    }

    // Add reasoning parameter for OpenRouter
    const isOpenRouter = this.client.baseURL?.includes('openrouter.ai');
    if (isOpenRouter && this.disableReasoningOverride) {
      requestPayload.reasoning = { enabled: false };
    }

    // Add reasoning parameter for NanoGPT
    const isNanoGPT = this.client.baseURL?.includes('nanogpt');
    if (isNanoGPT && this.disableReasoningOverride) {
      requestPayload.reasoning = { effort: "none" };
    }

    // Log tools being sent to API
    const toolNames = allTools
      .filter((t: any) => t.type === 'function')
      .map((t: any) => t.function.name);
    const mcpTools = toolNames.filter(name => name.startsWith('mcp__'));
    const webSearchEnabled = allTools.some((t: any) => t.type === 'web_search');

    const debugLogPath = ChatHistoryManager.getDebugLogPath();
    const logEntry = `${new Date().toISOString()} - API CALL: ${toolNames.length} tools (${mcpTools.length} MCP: ${mcpTools.join(', ')})${webSearchEnabled ? ' + web_search' : ''}\n`;
    fs.appendFileSync(debugLogPath, logEntry);

    // Retry loop for 429 errors
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.client.chat.completions.create(
          requestPayload,
          { signal: signal as any }
        );
        return response as LLMResponse;
      } catch (error: any) {
        // Check if model doesn't support tools
        const isToolsNotSupported = error.status === 400 &&
                                    error.message &&
                                    error.message.toLowerCase().includes('does not support tools');

        if (isToolsNotSupported && this.supportsTools) {
          // Disable tools for this model and rebuild request without tools
          this.supportsTools = false;
          console.error(`Model does not support tools.  Retrying without tools...`);

          // Shutdown MCP servers since they won't be usable without tools
          try {
            const { getMCPManager } = await import('../grok/tools.js');
            const mcpManager = getMCPManager();
            await mcpManager.shutdown();
            console.error(`MCP servers shut down.`);
          } catch (mcpError: any) {
            console.warn("MCP shutdown failed:", mcpError);
          }

          // Rebuild request payload without tools
          delete requestPayload.tools;
          delete requestPayload.tool_choice;

          continue;
        }

        // Check if model doesn't support vision (400 errors) or request is too large (413 errors)
        const isVisionNotSupported = ((error.status === 400 &&
                                       error.message &&
                                       (error.message.toLowerCase().includes('does not support vision') ||
                                        error.message.toLowerCase().includes('does not support images') ||
                                        error.message.toLowerCase().includes('image inputs are not supported') ||
                                        error.message.toLowerCase().includes('image_url'))) ||
                                      (error.status === 413 &&
                                       error.message &&
                                       error.message.toLowerCase().includes('request entity too large')));

        if (isVisionNotSupported && this.supportsVision) {
          // Disable vision for this model and rebuild request without images
          this.supportsVision = false;
          console.error(`Model does not support vision.  Retrying without images...`);

          // Strip images from all messages
          requestPayload.messages = requestPayload.messages.map((msg: any) => {
            if (Array.isArray(msg.content)) {
              // Keep only text content, remove image_url entries
              const textContent = msg.content.filter((item: any) => item.type === 'text');
              return {
                ...msg,
                content: textContent.length > 0 ? textContent[0].text : ''
              };
            }
            return msg;
          });

          continue;
        }

        // Check if 413 error when vision already disabled -- context too large
        if (error.status === 413 && !this.supportsVision) {
          throw new Error('CONTEXT_TOO_LARGE: ' + error.message);
        }

        // Check if it's a 429 rate limit error
        const is429 = error.status === 429 ||
                      error.code === 'rate_limit_exceeded' ||
                      (error.message && error.message.toLowerCase().includes('rate limit'));

        if (is429 && attempt < maxRetries) {
          console.error(`Rate limit hit (429). Retrying in ${retryDelay/1000}s... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }

        // Log 500 errors with full request/response for debugging
        if (error.status === 500) {
          const { requestFile, responseFile } = await logApiError(
            requestPayload,
            error,
            { errorType: 'runtime-api-error' },
            '500'
          );

          // Throw error with file references
          throw new Error(`${this.backendName} API error: ${error.message}\nRequest logged to: ${requestFile}\nResponse logged to: ${responseFile}`);
        }

        // If not 429 or out of retries, throw the error
        throw new Error(`${this.backendName} API error: ${error.message}`);
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('${this.backendName} API error: Max retries exceeded');
  }

  async *chatStream(
    messages: LLMMessage[],
    tools?: LLMTool[],
    model?: string,
    searchOptions?: SearchOptions,
    temperature?: number,
    signal?: AbortSignal,
    maxTokens?: number
  ): AsyncGenerator<any, void, unknown> {
    const maxRetries = 5;
    const retryDelay = 11000; // 11 seconds

    // Parse model suffix (from explicit param or current model)
    const modelToUse = model || this.currentModel;
    const cleanModelName = this.parseModelSuffix(modelToUse).cleanModel;

    // OpenAI detection for parameter compatibility
    const isOpenAI = this.client.baseURL?.includes('openai.com');

    const requestPayload: any = {
      model: cleanModelName,
      messages,
      temperature: temperature ?? 0.7,
      stream: true
    };

    // OpenAI models from gpt-5.x, o1, o3, o4-mini onwards require max_completion_tokens
    // instead of max_tokens.  Use max_completion_tokens for these newer models.
    const usesMaxCompletionTokens = isOpenAI && (
      cleanModelName.startsWith('gpt-5') ||
      cleanModelName.startsWith('o1') ||
      cleanModelName.startsWith('o3') ||
      cleanModelName.startsWith('o4-mini')
    );

    if (usesMaxCompletionTokens) {
      requestPayload.max_completion_tokens = maxTokens ?? this.defaultMaxTokens;
    } else {
      requestPayload.max_tokens = maxTokens ?? this.defaultMaxTokens;
    }

    // Build tools array (web_search disabled for Grok -- use Tavily instead)
    const allTools: any[] = [...(tools || [])];

    // DISABLED: Grok web_search temporarily disabled due to API inconsistencies
    // Agents should use Tavily for web search instead
    // if (searchOptions?.enable_web_search &&
    //     (this.client.baseURL ? this.isAllowedHost(this.client.baseURL, ['x.ai', 'api.x.ai']) : false)) {
    //   const webSearchTool: any = { type: "web_search" };
    //
    //   if (searchOptions.web_search_filters) {
    //     const filters = searchOptions.web_search_filters;
    //     if (filters.allowed_domains) webSearchTool.allowed_domains = filters.allowed_domains;
    //     if (filters.excluded_domains) webSearchTool.excluded_domains = filters.excluded_domains;
    //     if (filters.enable_image_understanding !== undefined) {
    //       webSearchTool.enable_image_understanding = filters.enable_image_understanding;
    //     }
    //     if (filters.user_location) webSearchTool.user_location = filters.user_location;
    //   }
    //
    //   allTools.push(webSearchTool as any);
    // }
    // // Legacy support for deprecated search_parameters - convert to new Agent Tools API format
    // else if (searchOptions?.search_parameters &&
    //     (this.client.baseURL ? this.isAllowedHost(this.client.baseURL, ['x.ai', 'api.x.ai']) : false)) {
    //   // Convert old search_parameters format to new web_search tool format
    //   if (searchOptions.search_parameters.mode === "on" || searchOptions.search_parameters.mode === "auto") {
    //     allTools.push({ type: "web_search" });
    //   }
    //   // mode === "off" means don't add the tool
    // }

    // OpenAI has a hard limit of 128 tools per request
    if (isOpenAI && allTools.length > 128) {
      console.error(`OpenAI tool limit: ${allTools.length} tools exceeds maximum of 128.  Trimming to 128 tools (base tools prioritized over MCP tools).`);
      allTools.splice(128);
    }

    // xAI Grok (Chat Completions path) has a hard limit of 200 tools per request
    const isGrok = this.client.baseURL?.includes('x.ai') || this.backendName.toLowerCase() === 'grok';
    if (isGrok && allTools.length > 200) {
      console.error(`Grok tool limit: ${allTools.length} tools exceeds maximum of 200.  Trimming to 200 tools.`);
      allTools.splice(200);
    }

    // Only include tools if the model supports them
    if (this.supportsTools) {
      requestPayload.tools = allTools;
    }

    // Only add think parameter for backends that support it (Grok, Ollama)
    const backendLower = this.backendName.toLowerCase();
    const supportsThink = backendLower === 'grok' ||
                          backendLower === 'ollama' ||
                          (this.client.baseURL ? this.isAllowedHost(this.client.baseURL, ['x.ai', 'api.x.ai']) : false);
    if (supportsThink) {
      requestPayload.think = false;
    }

    // Add reasoning parameter for OpenRouter
    const isOpenRouter = this.client.baseURL?.includes('openrouter.ai');
    if (isOpenRouter && this.disableReasoningOverride) {
      requestPayload.reasoning = { enabled: false };
    }

    // Add reasoning parameter for NanoGPT
    const isNanoGPT = this.client.baseURL?.includes('nanogpt');
    if (isNanoGPT && this.disableReasoningOverride) {
      requestPayload.reasoning = { effort: "none" };
    }

    // Venice uses venice_parameters.disable_thinking
    // DISABLED: Venice parameters may be causing API response issues
    // if (backendLower === 'venice') {
    //   requestPayload.venice_parameters = {
    //     disable_thinking: false,
    //     include_venice_system_prompt: false
    //   };
    // }

    // Only add tool_choice for backends that support it (OpenAI, Grok, OpenRouter)
    const supportsToolChoice = backendLower === 'grok' ||
                               backendLower === 'openai' ||
                               backendLower === 'openrouter' ||
                               (this.client.baseURL ? this.isAllowedHost(this.client.baseURL, ['x.ai', 'api.x.ai']) : false) ||
                               (this.client.baseURL ? this.isAllowedHost(this.client.baseURL, ['openai.com', 'api.openai.com']) : false) ||
                               (this.client.baseURL ? this.isAllowedHost(this.client.baseURL, ['openrouter.ai', 'api.openrouter.ai']) : false);
    if (this.supportsTools && supportsToolChoice && allTools.length > 0) {
      requestPayload.tool_choice = "auto";
    }

    // Retry loop for 429 errors
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const stream = (await this.client.chat.completions.create(
          requestPayload,
          { signal: signal as any }
        )) as any;

        for await (const chunk of stream) {
          // Check if signal was aborted
          if (signal?.aborted) {
            // Try to clean up the stream
            if (stream && typeof stream.controller?.abort === 'function') {
              stream.controller.abort();
            }
            break;
          }
          yield chunk;
        }
        return; // Success, exit the generator
      } catch (error: any) {
        // Check if model doesn't support tools
        const isToolsNotSupported = error.status === 400 &&
                                    error.message &&
                                    error.message.toLowerCase().includes('does not support tools');

        if (isToolsNotSupported && this.supportsTools) {
          // Disable tools for this model and rebuild request without tools
          this.supportsTools = false;
          console.error(`Model does not support tools.  Retrying without tools...`);

          // Shutdown MCP servers since they won't be usable without tools
          try {
            const { getMCPManager } = await import('../grok/tools.js');
            const mcpManager = getMCPManager();
            await mcpManager.shutdown();
            console.error(`MCP servers shut down.`);
          } catch (mcpError: any) {
            console.warn("MCP shutdown failed:", mcpError);
          }

          // Rebuild request payload without tools
          delete requestPayload.tools;
          delete requestPayload.tool_choice;

          continue;
        }

        // Check if model doesn't support vision (400 errors) or request is too large (413 errors)
        const isVisionNotSupported = ((error.status === 400 &&
                                       error.message &&
                                       (error.message.toLowerCase().includes('does not support vision') ||
                                        error.message.toLowerCase().includes('does not support images') ||
                                        error.message.toLowerCase().includes('image inputs are not supported') ||
                                        error.message.toLowerCase().includes('image_url'))) ||
                                      (error.status === 413 &&
                                       error.message &&
                                       error.message.toLowerCase().includes('request entity too large')));

        if (isVisionNotSupported && this.supportsVision) {
          // Disable vision for this model and rebuild request without images
          this.supportsVision = false;
          console.error(`Model does not support vision.  Retrying without images...`);

          // Strip images from all messages
          requestPayload.messages = requestPayload.messages.map((msg: any) => {
            if (Array.isArray(msg.content)) {
              // Keep only text content, remove image_url entries
              const textContent = msg.content.filter((item: any) => item.type === 'text');
              return {
                ...msg,
                content: textContent.length > 0 ? textContent[0].text : ''
              };
            }
            return msg;
          });

          continue;
        }

        // Check if 413 error when vision already disabled -- context too large
        if (error.status === 413 && !this.supportsVision) {
          throw new Error('CONTEXT_TOO_LARGE: ' + error.message);
        }

        // Check if it's a 429 rate limit error
        const is429 = error.status === 429 ||
                      error.code === 'rate_limit_exceeded' ||
                      (error.message && error.message.toLowerCase().includes('rate limit'));

        if (is429 && attempt < maxRetries) {
          console.error(`Rate limit hit (429). Retrying in ${retryDelay/1000}s... (attempt ${attempt + 1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
          continue;
        }

        // Log 500 errors with full request/response for debugging
        if (error.status === 500) {
          const { requestFile, responseFile } = await logApiError(
            requestPayload,
            error,
            { errorType: 'runtime-api-error' },
            '500'
          );

          // Throw error with file references
          throw new Error(`${this.backendName} API error: ${error.message}\nRequest logged to: ${requestFile}\nResponse logged to: ${responseFile}`);
        }

        // If not 429 or out of retries, throw the error
        throw new Error(`${this.backendName} API error: ${error.message}`);
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error(`${this.backendName} API error: Max retries exceeded`);
  }

  /**
   * @deprecated This method uses the deprecated search_parameters API.
   *
   * Migrate to using chat() with enable_web_search instead:
   *
   * ```typescript
   * const searchOptions: SearchOptions = {
   *   enable_web_search: true,
   *   web_search_filters: {
   *     allowed_domains: ['example.com'],  // optional
   *     excluded_domains: ['spam.com'],    // optional
   *     enable_image_understanding: true   // optional
   *   }
   * };
   *
   * await client.chat([{role: "user", content: query}], [], undefined, searchOptions);
   * ```
   *
   * The search_parameters field was deprecated by Grok API on December 15, 2025.
   * See: https://docs.x.ai/docs/guides/tools/search-tools
   */
  async search(
    query: string,
    searchParameters?: SearchParameters
  ): Promise<LLMResponse> {
    const searchMessage: LLMMessage = {
      role: "user",
      content: query,
    };

    // Use new Agent Tools API format instead of deprecated search_parameters
    const searchOptions: SearchOptions = {
      enable_web_search: true,
    };

    return this.chat([searchMessage], [], undefined, searchOptions);
  }

  /**
   * Returns true if the host part of baseURL matches one of the allowedHosts or a subdomain thereof.
   */
  private isAllowedHost(urlString: string, allowedHosts: string[]): boolean {
    try {
      const { hostname } = new URL(urlString);
      return allowedHosts.some(allowedHost =>
        hostname === allowedHost || hostname.endsWith(`.${allowedHost}`)
      );
    } catch (e) {
      return false;
    }
  }
}
