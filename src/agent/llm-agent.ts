import { LLMClient, LLMMessage, LLMToolCall } from "../grok/client.js";
import { GrokResponsesClient, shouldUseResponsesAPI } from "../grok/responses-client.js";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions.js";
import {
  LLM_TOOLS,
  addMCPToolsToLLMTools,
  getAllLLMTools,
  getMCPManager,
  initializeMCPServers,
  setHeadlessMode,
} from "../grok/tools.js";
import { loadMCPConfig } from "../mcp/config.js";
import { ChatHistoryManager } from "../utils/chat-history-manager.js";
import { logApiError } from "../utils/error-logger.js";
import { parseImagesFromMessage, hasImageReferences } from "../utils/image-encoder.js";
import { getTextContent } from "../utils/content-utils.js";
import { Variable } from "./prompt-variables.js";
import fs from "fs";
import {
  TextEditorTool,
  MorphEditorTool,
  ZshTool,
  ConfirmationTool,
  SearchTool,
  EnvTool,
  IntrospectTool,
  ClearCacheTool,
  CharacterTool,
  TaskManagementTool,
  TaskTool,
  InternetTool,
  ImageTool,
  FileConversionTool,
  RestartTool,
  AudioTool
} from "../tools/index.js";
import { ToolResult } from "../types/index.js";
import { EventEmitter } from "events";
import { createTokenCounter, TokenCounter } from "../utils/token-counter.js";
import { loadCustomInstructions } from "../utils/custom-instructions.js";
import { getSettingsManager } from "../utils/settings-manager.js";
import { executeOperationHook, applyHookCommands, applyEnvVariables } from "../utils/hook-executor.js";
import { ToolExecutor } from "./tool-executor.js";
import { HookManager } from "./hook-manager.js";
import { SessionManager } from "./session-manager.js";
import { MessageProcessor } from "./message-processor.js";
import { ContextManager } from "./context-manager.js";
import { SessionState } from "../utils/chat-history-manager.js";

// Interval (ms) between token count updates when streaming
const TOKEN_UPDATE_INTERVAL_MS = 250;

/**
 * Threshold used to determine whether an AI response is "substantial" (in characters).
 */
const SUBSTANTIAL_RESPONSE_THRESHOLD = 50;

/**
 * Extracts the first complete JSON object from a string.
 * Handles duplicate/concatenated JSON objects (LLM bug) like: {"key":"val"}{"key":"val"}
 * @param jsonString The string potentially containing concatenated JSON objects
 * @returns The first complete JSON object, or the original string if no duplicates found
 */
function extractFirstJsonObject(jsonString: string): string {
  if (!jsonString.includes('}{')) return jsonString;
  try {
    // Find the end of the first complete JSON object
    let depth = 0;
    let firstObjEnd = -1;
    for (let i = 0; i < jsonString.length; i++) {
      if (jsonString[i] === "{") depth++;
      if (jsonString[i] === "}") {
        depth--;
        if (depth === 0) {
          firstObjEnd = i + 1;
          break;
        }
      }
    }
    if (firstObjEnd > 0 && firstObjEnd < jsonString.length) {
      // Extract and validate first object
      const firstObj = jsonString.substring(0, firstObjEnd);
      JSON.parse(firstObj); // Validate it's valid JSON
      return firstObj;
    }
  } catch {
    // If extraction fails, return the original string
  }
  return jsonString;
}

/**
 * Cleans up LLM-generated JSON argument strings for tool calls.
 * Removes duplicate/concatenated JSON objects and trims.
 * @param args The raw arguments string from the tool call
 * @returns Cleaned and sanitized argument string
 */
function sanitizeToolArguments(args: string | undefined): string {
  let argsString = args?.trim() || "{}";

  // Handle duplicate/concatenated JSON objects (LLM bug)
  const extractedArgsString = extractFirstJsonObject(argsString);
  if (extractedArgsString !== argsString) {
    argsString = extractedArgsString;
  }

  return argsString;
}

/**
 * Represents a single entry in the conversation history.
 * Supports various message types including user messages, assistant responses,
 * tool calls, tool results, and system messages.
 */
export interface ChatEntry {
  type: "user" | "assistant" | "tool_result" | "tool_call" | "system";
  content?: string | ChatCompletionContentPart[];
  originalContent?: string | ChatCompletionContentPart[];
  timestamp: Date;
  tool_calls?: LLMToolCall[];
  toolCall?: LLMToolCall;
  toolResult?: { success: boolean; output?: string; error?: string; displayOutput?: string };
  isStreaming?: boolean;
  preserveFormatting?: boolean;
  metadata?: {
    rephrased_note?: string;
    [key: string]: any;
  };
}

/**
 * Represents a chunk of data in the streaming response.
 * Used for real-time communication between the agent and UI components.
 */
export interface StreamingChunk {
  type: "content" | "tool_calls" | "tool_result" | "done" | "token_count" | "user_message";
  content?: string;
  tool_calls?: LLMToolCall[];
  toolCall?: LLMToolCall;
  toolResult?: ToolResult;
  tokenCount?: number;
  userEntry?: ChatEntry;
  systemMessages?: ChatEntry[];
}

/**
 * Main LLM Agent class that orchestrates AI conversations with tool execution capabilities.
 *
 * ## Architecture Overview
 *
 * The LLMAgent serves as the central coordinator for AI-powered conversations, managing:
 * - **Conversation Flow**: Handles user messages, AI responses, and multi-turn conversations
 * - **Tool Execution**: Coordinates with various tools (file editing, shell commands, web search, etc.)
 * - **Context Management**: Tracks conversation history and manages token limits
 * - **Session State**: Maintains persona, mood, active tasks, and other session data
 * - **Streaming Support**: Provides real-time response streaming for better UX
 *
 * ## Delegation Architecture
 *
 * The agent delegates specialized functionality to focused manager classes:
 * - **ToolExecutor**: Handles all tool execution, validation, and approval workflows
 * - **HookManager**: Manages persona/mood/task hooks and backend testing
 * - **SessionManager**: Handles session persistence and state restoration
 * - **MessageProcessor**: Processes user input, handles rephrasing, and XML parsing
 * - **ContextManager**: Manages context warnings, compaction, and token tracking
 *
 * ## Key Features
 *
 * - **Multi-Model Support**: Works with various LLM backends (Grok, OpenAI, etc.)
 * - **Tool Integration**: Seamlessly integrates with 15+ built-in tools
 * - **MCP Support**: Extends capabilities via Model Context Protocol servers
 * - **Vision Support**: Handles image inputs for vision-capable models
 * - **Streaming Responses**: Real-time response generation with token counting
 * - **Context Awareness**: Intelligent context management and automatic compaction
 * - **Hook System**: Extensible hook system for custom behaviors
 * - **Session Persistence**: Maintains conversation state across restarts
 *
 * ## Usage Patterns
 *
 * ```typescript
 * // Initialize agent
 * const agent = new LLMAgent(apiKey, baseURL, model);
 * await agent.initialize();
 *
 * // Process messages (non-streaming)
 * const entries = await agent.processUserMessage("Hello, world!");
 *
 * // Process messages (streaming)
 * for await (const chunk of agent.processUserMessageStream("Write a file")) {
 *   console.log(chunk);
 * }
 *
 * // Manage session state
 * await agent.setPersona("helpful assistant");
 * await agent.startActiveTask("coding", "writing tests");
 * ```
 *
 * @extends EventEmitter Emits 'contextChange' events for token usage updates
 */
export class LLMAgent extends EventEmitter {
  private llmClient: LLMClient | GrokResponsesClient;
  private textEditor: TextEditorTool;
  private morphEditor: MorphEditorTool | null;
  private zsh: ZshTool;
  private confirmationTool: ConfirmationTool;
  private search: SearchTool;
  private env: EnvTool;
  private introspect: IntrospectTool;
  private clearCacheTool: ClearCacheTool;
  private characterTool: CharacterTool;
  private taskManagementTool: TaskManagementTool;
  private taskTool: TaskTool;
  private internetTool: InternetTool;
  private imageTool: ImageTool;
  private fileConversionTool: FileConversionTool;
  private restartTool: RestartTool | null = null;
  private audioTool: AudioTool;
  private chatHistory: ChatEntry[] = [];
  private messages: LLMMessage[] = [];
  private tokenCounter: TokenCounter;
  private abortController: AbortController | null = null;
  private mcpInitialized: boolean = false;
  private mcpInitPromise: Promise<void> | null = null;
  private maxToolRounds: number;
  private temperature: number;
  private maxTokens: number | undefined;
  private firstMessageProcessed: boolean = false;
  private persona: string = "";
  private personaColor: string = "white";
  private mood: string = "";
  private moodColor: string = "white";
  private activeTask: string = "";
  private activeTaskAction: string = "";
  private activeTaskColor: string = "white";
  private apiKeyEnvVar: string = "GROK_API_KEY";
  private pendingContextEditSession: { tmpJsonPath: string; contextFilePath: string } | null = null;
  private rephraseState: {
    originalAssistantMessageIndex: number;
    rephraseRequestIndex: number;
    newResponseIndex: number;
    messageType: "user" | "system";
    prefillText?: string;
  } | null = null;
  private toolExecutor: ToolExecutor;
  private hookManager: HookManager;
  private sessionManager: SessionManager;
  private messageProcessor: MessageProcessor;
  private contextManager: ContextManager;
  private maxContextSize: number = 128000; // Default context size, can be overridden by MAXCONTEXT hook command



  /**
   * Cleans up incomplete tool calls in the message history.
   * Ensures all tool calls have corresponding tool results to prevent API errors.
   *
   * This method scans the last assistant message for tool calls and adds
   * "[Cancelled by user]" results for any tool calls that don't have results.
   *
   * @private
   */
  private buildToolCallEntry(toolCall: LLMToolCall): ChatEntry {
    let rationale: string = '';
    try {
      const parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
      rationale = typeof parsedArgs.rationale === 'string' ? parsedArgs.rationale : '';
    } catch { /* ignore parse errors */ }
    return {
      type: "tool_call",
      content: "Executing...",
      timestamp: new Date(),
      toolCall: toolCall,
      metadata: { rationale },
    };
  }

  private async cleanupIncompleteToolCalls(): Promise<void> {
    const lastMessage = this.messages[this.messages.length - 1];
    if (lastMessage?.role === "assistant" && lastMessage.tool_calls) {
      const toolCallIds = new Set(lastMessage.tool_calls.map((tc: any) => tc.id));
      const completedToolCallIds = new Set();

      for (let i = this.messages.length - 1; i >= 0; i--) {
        const msg = this.messages[i] as any;
        if (msg.role === "tool" && msg.tool_call_id) {
          completedToolCallIds.add(msg.tool_call_id);
        }
        if (this.messages[i] === lastMessage) break;
      }

      for (const toolCallId of toolCallIds) {
        if (!completedToolCallIds.has(toolCallId)) {
          console.error(`Adding cancelled result for incomplete tool call: ${toolCallId}`);
          this.messages.push({
            role: "tool",
            content: "[Cancelled by user]",
            tool_call_id: toolCallId,
          });
        }
      }
    }
  }

  /**
   * Executes the instance hook if it hasn't been run yet.
   *
   * The instance hook runs once per agent session and can:
   * - Set prompt variables
   * - Add system messages
   * - Provide prefill text for responses
   *
   * @private
   */
  private async executeInstanceHookIfNeeded(): Promise<void> {
    if (!this.hasRunInstanceHook) {
      this.hasRunInstanceHook = true;
      const settings = getSettingsManager();
      const instanceHookPath = settings.getInstanceHook();
      if (instanceHookPath) {
        const hookResult = await executeOperationHook(
          instanceHookPath,
          "instance",
          {},
          30000,
          false,
          this.getCurrentTokenCount(),
          this.getMaxContextSize()
        );

        if (hookResult.approved && hookResult.commands && hookResult.commands.length > 0) {
          const results = applyHookCommands(hookResult.commands);

          applyEnvVariables(results.env);

          const seenVars = new Set<string>();
          for (const {name, value} of results.promptVars) {
            if (seenVars.has(name)) {
              Variable.append(name, value);
            } else {
              Variable.set(name, value);
              seenVars.add(name);
            }
          }

          // Process hook commands through HookManager
          // Note: This is a simplified version - full hook processing is now in HookManager
          if (results.system) {
            this.messages.push({
              role: 'system',
              content: results.system
            });
          }

          if (results.prefill) {
            this.messageProcessor.setHookPrefillText(results.prefill);
          }

          if (results.maxContext !== undefined) {
            this.maxContextSize = results.maxContext;
          }
        }
      }
    }
  }

  /**
   * Creates a new LLMAgent instance.
   *
   * @param apiKey - API key for the LLM service
   * @param baseURL - Optional base URL for the API endpoint
   * @param model - Optional model name (defaults to saved model or "grok-code-fast-1")
   * @param maxToolRounds - Maximum number of tool execution rounds (default: 400)
   * @param debugLogFile - Optional path for MCP debug logging
   * @param startupHookOutput - Optional output from startup hook execution
   * @param temperature - Optional temperature for API requests (0.0-2.0)
   * @param maxTokens - Optional maximum tokens for API responses
   */
  constructor(
    apiKey: string,
    baseURL?: string,
    model?: string,
    maxToolRounds?: number,
    debugLogFile?: string,
    startupHookOutput?: string,
    temperature?: number,
    maxTokens?: number,
    isHeadless?: boolean
  ) {
    super();
    const manager = getSettingsManager();
    const savedModel = manager.getCurrentModel();
    const modelToUse = model || savedModel || "grok-code-fast-1";
    this.maxToolRounds = maxToolRounds || 400;
    this.temperature = temperature ?? manager.getTemperature();
    this.maxTokens = maxTokens ?? manager.getMaxTokens();
    // Get display name from environment (set by zai/helpers)
    const displayName = process.env.GROK_BACKEND_DISPLAY_NAME;
    // Use GrokResponsesClient when GROK_USE_RESPONSES_API=true and backend is grok
    if (shouldUseResponsesAPI(displayName ?? '')) {
      this.llmClient = new GrokResponsesClient(apiKey, modelToUse, baseURL, displayName);
    } else {
      this.llmClient = new LLMClient(apiKey, modelToUse, baseURL, displayName);
    }

    // Set apiKeyEnvVar based on backend name
    const backendName = this.llmClient.getBackendName().toUpperCase();
    this.apiKeyEnvVar = `${backendName}_API_KEY`;

    this.textEditor = new TextEditorTool();
    this.morphEditor = process.env.MORPH_API_KEY ? new MorphEditorTool() : null;
    this.zsh = new ZshTool();
    this.confirmationTool = new ConfirmationTool();
    this.search = new SearchTool();
    this.env = new EnvTool();
    this.introspect = new IntrospectTool();
    this.clearCacheTool = new ClearCacheTool();
    if (isHeadless) {
      setHeadlessMode(true);
    } else {
      this.restartTool = new RestartTool();
    }
    this.characterTool = new CharacterTool();
    this.taskManagementTool = new TaskManagementTool();
    this.taskManagementTool.setAgent(this);
    this.taskTool = new TaskTool();
    this.internetTool = new InternetTool();
    this.imageTool = new ImageTool();
    this.fileConversionTool = new FileConversionTool();
    this.audioTool = new AudioTool();
    this.textEditor.setAgent(this); // Give text editor access to agent for context awareness
    this.introspect.setAgent(this); // Give introspect access to agent for tool class info
    this.clearCacheTool.setAgent(this); // Give clearCache access to agent
    this.characterTool.setAgent(this); // Give character tool access to agent
    this.taskTool.setAgent(this); // Give task tool access to agent
    this.internetTool.setAgent(this); // Give internet tool access to agent
    this.imageTool.setAgent(this); // Give image tool access to agent
    this.zsh.setAgent(this); // Give zsh tool access to agent for CWD tracking
    this.tokenCounter = createTokenCounter(modelToUse);

    // Initialize tool executor
    this.toolExecutor = new ToolExecutor(
      this, this.textEditor, this.morphEditor, this.zsh, this.search,
      this.env, this.introspect, this.clearCacheTool, this.restartTool,
      this.characterTool, this.taskTool, this.internetTool, this.imageTool,
      this.fileConversionTool, this.audioTool, this.taskManagementTool
    );

    // Initialize hook manager
    this.hookManager = new HookManager({
      getLLMClient: () => this.llmClient,
      getTokenCounter: () => this.tokenCounter,
      apiKeyEnvVar: this.apiKeyEnvVar,
      messages: this.messages,
      chatHistory: this.chatHistory,
      temperature: this.temperature,
      getCurrentTokenCount: () => this.getCurrentTokenCount(),
      getMaxContextSize: () => this.getMaxContextSize(),
      getCurrentModel: () => this.getCurrentModel(),
      emit: (event: string, data: any) => this.emit(event, data),
      setApiKeyEnvVar: (value: string) => { this.apiKeyEnvVar = value; },
      setTokenCounter: (counter: TokenCounter) => { this.tokenCounter = counter; },
      setLLMClient: (client: LLMClient | GrokResponsesClient) => { this.llmClient = client; },
      setPersona: (persona: string, color: string) => { this.persona = persona; this.personaColor = color; },
      setMood: (mood: string, color: string) => { this.mood = mood; this.moodColor = color; },
      setActiveTask: (task: string, action: string, color: string) => { this.activeTask = task; this.activeTaskAction = action; this.activeTaskColor = color; }
    });

    // Initialize session manager
    this.sessionManager = new SessionManager({
      getLLMClient: () => this.llmClient,
      getTokenCounter: () => this.tokenCounter,
      getApiKeyEnvVar: () => this.apiKeyEnvVar,
      hookManager: this.hookManager,
      getPersona: () => this.persona,
      getPersonaColor: () => this.personaColor,
      getMood: () => this.mood,
      getMoodColor: () => this.moodColor,
      getActiveTask: () => this.activeTask,
      getActiveTaskAction: () => this.activeTaskAction,
      getActiveTaskColor: () => this.activeTaskColor,
      getCurrentModel: () => this.getCurrentModel(),
      emit: (event: string, data: any) => this.emit(event, data),
      setLLMClient: (client: LLMClient | GrokResponsesClient) => { this.llmClient = client; },
      setTokenCounter: (counter: TokenCounter) => { this.tokenCounter = counter; },
      setApiKeyEnvVar: (value: string) => { this.apiKeyEnvVar = value; },
      setPersona: (persona: string, color: string) => { this.persona = persona; this.personaColor = color; },
      setMood: (mood: string, color: string) => { this.mood = mood; this.moodColor = color; },
      setActiveTask: (task: string, action: string, color: string) => { this.activeTask = task; this.activeTaskAction = action; this.activeTaskColor = color; }
    });

    // Initialize message processor
    this.messageProcessor = new MessageProcessor({
      chatHistory: this.chatHistory,
      getCurrentTokenCount: () => this.getCurrentTokenCount(),
      getMaxContextSize: () => this.getMaxContextSize(),
      setRephraseState: (originalAssistantMessageIndex: number, rephraseRequestIndex: number, newResponseIndex: number, messageType: "user" | "system", prefillText?: string) => {
        this.setRephraseState(originalAssistantMessageIndex, rephraseRequestIndex, newResponseIndex, messageType, prefillText);
      }
    });

    // Initialize context manager
    this.contextManager = new ContextManager({
      chatHistory: this.chatHistory,
      messages: this.messages,
      tokenCounter: this.tokenCounter,
      getCurrentTokenCount: () => this.getCurrentTokenCount(),
      getMaxContextSize: () => this.getMaxContextSize(),
      emit: (event: string, data: any) => this.emit(event, data),
      clearCache: () => this.clearCache()
    });

    // Initialize MCP servers if configured (store promise so buildSystemMessage can await it)
    this.mcpInitPromise = this.initializeMCP(debugLogFile);

    // System message will be set after async initialization
    this.messages.push({
      role: "system",
      content: "Initializing...", // Temporary, will be replaced in initialize()
    });

    // Note: THE system prompt is NOT added to chatHistory
    // Only conversational system messages go in chatHistory

    // Store startup hook output for later use
    this.startupHookOutput = startupHookOutput;
  }

  private startupHookOutput?: string;
  private systemPrompt: string = "Initializing..."; // THE system prompt (always at messages[0])
  private hasRunInstanceHook: boolean = false;

  /**
   * Initialize the agent with dynamic system prompt.
   *
   * This method must be called after construction to:
   * - Build the system message with current tool availability
   * - Set up the initial conversation context
   * - Execute the instance hook if configured
   *
   * @throws {Error} If system message generation fails
   */
  async initialize(): Promise<void> {
    // Build system message
    await this.buildSystemMessage();

    // Run instance hook after initialization is complete
    await this.executeInstanceHookIfNeeded();
  }

  /**
   * Build/rebuild the system message with current tool availability.
   *
   * This method:
   * - Generates a dynamic tool list using the introspect tool
   * - Sets the APP:TOOLS variable for template rendering
   * - Renders the full SYSTEM template with all variables
   * - Updates messages[0] with the new system prompt
   *
   * The system prompt is always at messages[0] and contains the core
   * instructions, tool descriptions, and current context information.
   */
  async buildSystemMessage(): Promise<void> {
    // Wait for MCP init to complete so serverTools is populated before generateToolSections runs
    if (this.mcpInitPromise) {
      try { await this.mcpInitPromise; } catch {}
    }
    // Generate tool sections split by type for separate APP:TOOLS:* variables
    const sections = await this.introspect.generateToolSections();
    Variable.set("APP:TOOLS:BASE", sections.base || "");
    Variable.set("APP:TOOLS:MCP", sections.mcp || "");
    Variable.set("APP:TOOLS:SKILLZ", sections.skillz || "");

    // Note: System prompt rendering moved to renderSystemMessage()
    // which is called just before each LLM API call to ensure
    // variables reflect current state including hook-set values
  }

  /**
   * Render system message with current variable state
   * Called before LLM API calls and task processing to ensure fresh content
   */
  renderSystemMessage(): void {
    // Render SYSTEM template with current variables
    this.systemPrompt = Variable.renderFull('SYSTEM');

    // Update messages[0] with the rendered system prompt
    this.messages[0] = {
      role: "system",
      content: this.systemPrompt,
    };
  }

  /**
   * Load initial conversation history from persistence.
   *
   * This method:
   * - Loads the chat history (excluding system messages)
   * - Sets or generates the system prompt
   * - Converts history to API message format
   * - Handles tool call/result matching
   * - Updates token counts
   *
   * @param history - Array of chat entries to load
   * @param systemPrompt - Optional system prompt (will generate if not provided)
   */
  async loadInitialHistory(history: ChatEntry[], systemPrompt?: string): Promise<void> {
    // Load chatHistory mutating in place to preserve ContextManager's array reference
    this.chatHistory.length = 0;
    this.chatHistory.push(...history);

    // Set system prompt if provided, otherwise generate one
    if (systemPrompt) {
      this.setSystemPrompt(systemPrompt);
    } else {
      await this.buildSystemMessage();
    }

    // Instance hook now runs in initialize() for both fresh and existing sessions

    // Convert history to messages format for API calls
    const historyMessages: LLMMessage[] = [];

    // Track which tool_call_ids we've seen in assistant messages
    const seenToolCallIds = new Set<string>();

    // First pass: collect all tool_call_ids from assistant messages
    for (const entry of history) {
      if (entry.type === "assistant" && entry.tool_calls) {
        entry.tool_calls.forEach(tc => seenToolCallIds.add(tc.id));
      }
    }

    // Second pass: build history messages, only including tool_results that have matching tool_calls
    const toolResultMessages: LLMMessage[] = [];
    const toolCallIdToMessage: Map<string, LLMMessage> = new Map();

    for (const entry of history) {
      switch (entry.type) {
        case "system":
          // All system messages from chatHistory go into conversation (persona, mood, etc.)
          // System messages must always be strings
          historyMessages.push({
            role: "system",
            content: getTextContent(entry.content),
          });
          break;
        case "user":
          // User messages can have images (content arrays)
          historyMessages.push({
            role: "user",
            content: entry.content || "",
          });
          break;
        case "assistant":
          // Assistant messages are always text (no images in responses)
          const assistantMessage: LLMMessage = {
            role: "assistant",
            content: getTextContent(entry.content) || "", // Ensure content is never null/undefined
          };
          if (entry.tool_calls && entry.tool_calls.length > 0) {
            // For assistant messages with tool calls, collect the tool results that correspond to them
            const correspondingToolResults: LLMMessage[] = [];
            const toolCallsWithResults: LLMToolCall[] = [];

            entry.tool_calls.forEach(tc => {
              // Find the tool_result entry for this tool_call
              const toolResultEntry = history.find(h => h.type === "tool_result" && h.toolCall?.id === tc.id);
              if (toolResultEntry) {
                // Only include this tool_call if we have its result
                toolCallsWithResults.push(tc);
                correspondingToolResults.push({
                  role: "tool",
                  content: toolResultEntry.toolResult?.output || toolResultEntry.toolResult?.error || "",
                  tool_call_id: tc.id,
                });
              }
            });

            // Only add tool_calls if we have at least one with a result
            if (toolCallsWithResults.length > 0) {
              assistantMessage.tool_calls = toolCallsWithResults;
              // Add assistant message
              historyMessages.push(assistantMessage);
              // Add corresponding tool results immediately after
              historyMessages.push(...correspondingToolResults);
            } else {
              // No tool results found, just add the assistant message without tool_calls
              historyMessages.push(assistantMessage);
            }
          } else {
            historyMessages.push(assistantMessage);
          }
          break;
        case "tool_result":
          // Skip tool_result entries here - they're handled when processing assistant messages with tool_calls
          break;
        // Skip tool_call entries as they are included with assistant
      }
    }

    // Insert history messages after the system message
    this.messages.splice(1, 0, ...historyMessages);

    // Update token count in system message
    const currentTokens = this.tokenCounter.countTokens(
      this.messages.map(m => typeof m.content === 'string' ? m.content : '').join('')
    );
    if (this.messages.length > 0 && this.messages[0].role === 'system' && typeof this.messages[0].content === 'string') {
      this.messages[0].content = this.messages[0].content.replace(/Current conversation token usage: .*/, `Current conversation token usage: ${currentTokens}`);
    }
  }

  /**
   * Initialize Model Context Protocol (MCP) servers in the background.
   *
   * This method loads MCP configuration and initializes any configured
   * servers without blocking agent construction. Errors are logged but
   * don't prevent agent operation.
   *
   * @param debugLogFile - Optional path for MCP debug output
   * @private
   */
  private async initializeMCP(debugLogFile?: string): Promise<void> {
    try {
      const config = loadMCPConfig();
      if (config.servers.length > 0) {
        await initializeMCPServers(debugLogFile);
      }
    } catch (error) {
      console.warn("MCP initialization failed:", error);
    } finally {
      this.mcpInitialized = true;
    }
  }

  /**
   * Checks if the current model is a Grok model.
   * Used to enable Grok-specific features like web search.
   *
   * @returns True if the current model name contains "grok"
   * @private
   */
  private isGrokModel(): boolean {
    const currentModel = this.llmClient.getCurrentModel();
    return currentModel.toLowerCase().includes("grok");
  }

  /**
   * Heuristic to determine if web search should be enabled for a message.
   *
   * Analyzes the message content for keywords that suggest the user is
   * asking for current information, news, or time-sensitive data.
   *
   * @param message - The user message to analyze
   * @returns True if web search should be enabled
   * @private
   */
  private shouldUseSearchFor(message: string): boolean {
    const q = message.toLowerCase();
    const keywords = [
      "today",
      "latest",
      "news",
      "trending",
      "breaking",
      "current",
      "now",
      "recent",
      "x.com",
      "twitter",
      "tweet",
      "what happened",
      "as of",
      "update on",
      "release notes",
      "changelog",
      "price",
    ];
    if (keywords.some((k) => q.includes(k))) return true;
    // crude date pattern (e.g., 2024/2025) may imply recency
    if (/(20\d{2})/.test(q)) return true;
    return false;
  }

  /**
   * Process a user message and return all conversation entries generated.
   *
   * This is the main non-streaming message processing method that:
   * - Handles rephrase commands and message preprocessing
   * - Manages the agent loop with tool execution
   * - Processes multiple rounds of AI responses and tool calls
   * - Handles errors and context management
   * - Returns all new conversation entries
   *
   * ## Processing Flow
   *
   * 1. **Setup**: Parse rephrase commands, clean incomplete tool calls
   * 2. **Message Processing**: Parse images, assemble content, add to history
   * 3. **Agent Loop**: Continue until no more tool calls or max rounds reached
   *    - Get AI response
   *    - Execute any tool calls
   *    - Add results to conversation
   *    - Get next response if needed
   * 4. **Cleanup**: Handle errors, update context, return entries
   *
   * @param message - The user message to process
   * @returns Promise resolving to array of new conversation entries
   * @throws {Error} If message processing fails critically
   */
  async processUserMessage(message: string): Promise<ChatEntry[]> {
    const {isRephraseCommand, messageType, messageToSend, prefillText} = await this.messageProcessor.setupRephraseCommand(message);
    await this.cleanupIncompleteToolCalls();
    Variable.clearOneShot();

    // Execute postUserInput hook
    const postUserInputHookPath = getSettingsManager().getPostUserInputHook();
    if (postUserInputHookPath) {
      const hookResult = await executeOperationHook(
        postUserInputHookPath,
        "postUserInput",
        { USER_MESSAGE: message },
        30000,
        false,
        this.getCurrentTokenCount(),
        this.getMaxContextSize()
      );

      if (hookResult.approved && hookResult.commands) {
        const results = applyHookCommands(hookResult.commands);
        applyEnvVariables(results.env);
        const seenVars = new Set<string>();
        for (const {name, value} of results.promptVars) {
          if (seenVars.has(name)) {
            Variable.append(name, value);
          } else {
            Variable.set(name, value);
            seenVars.add(name);
          }
        }
        if (results.prefill) {
          this.messageProcessor.setHookPrefillText(results.prefill);
        }
        if (results.maxContext !== undefined) {
          this.maxContextSize = results.maxContext;
        }
      }
    }

    const newEntries: ChatEntry[] = [];
    const maxToolRounds = this.maxToolRounds; // Prevent infinite loops
    let toolRounds = 0;
    let consecutiveNonToolResponses = 0;
    let userEntry: ChatEntry | undefined = undefined;

    try {
      // Execute preLLMResponse hook just before LLM call
      const hookPath = getSettingsManager().getPreLLMResponseHook();
      if (hookPath) {
        const hookResult = await executeOperationHook(
          hookPath,
          "preLLMResponse",
          { USER_MESSAGE: message },
          30000,
          false,
          this.getCurrentTokenCount(),
          this.getMaxContextSize()
        );

        if (hookResult.approved && hookResult.commands) {
          const results = applyHookCommands(hookResult.commands);
          applyEnvVariables(results.env);
          const seenVars = new Set<string>();
          for (const {name, value} of results.promptVars) {
            if (seenVars.has(name)) {
              Variable.append(name, value);
            } else {
              Variable.set(name, value);
              seenVars.add(name);
            }
          }
          if (results.prefill) {
            this.messageProcessor.setHookPrefillText(results.prefill);
          }
        }
      }

      // Parse and assemble message AFTER hooks have set USER:* variables
      const {parsed, assembledMessage} = await this.messageProcessor.parseAndAssembleMessage(messageToSend);
      const preparedMessage = this.messageProcessor.prepareMessageContent(messageType, assembledMessage, parsed, messageToSend, this.llmClient.getSupportsVision());
      userEntry = preparedMessage.userEntry;
      const messageContent = preparedMessage.messageContent;

      this.chatHistory.push(userEntry);
      newEntries.push(userEntry);
      if (messageType === "user") {
        this.messages.push({ role: "user", content: messageContent });
      } else {
        this.messages.push({ role: "system", content: typeof messageContent === "string" ? messageContent : messageToSend });
      }
      await this.contextManager.emitContextChange();

      // If rephrase or hook returned prefill text, add the assistant message now
      const rephraseText = this.rephraseState?.prefillText;
      const hookPrefillText = this.messageProcessor.getHookPrefillText();
      if (rephraseText) {
        this.messages.push({
          role: "assistant",
          content: rephraseText
        });
      } else if (hookPrefillText) {
        this.messages.push({
          role: "assistant",
          content: hookPrefillText
        });
      }

      // Render system message with current variable state before sending to LLM
      this.renderSystemMessage();

      const supportsTools = this.llmClient.getSupportsTools();
      let currentResponse = await this.llmClient.chat(
        this.messages,
        supportsTools ? await getAllLLMTools() : [],
        undefined,
        this.isGrokModel() && this.shouldUseSearchFor(message)
          ? { search_parameters: { mode: "auto" } }
          : { search_parameters: { mode: "off" } },
        this.temperature,
        this.abortController?.signal,
        this.maxTokens
      );

      // Parse XML tool calls from response if present
      if (currentResponse.choices?.[0]?.message) {
        currentResponse.choices[0].message = this.messageProcessor.parseXMLToolCalls(currentResponse.choices[0].message);
      }

      // Agent loop - continue until no more tool calls or max rounds reached
      while (toolRounds < maxToolRounds) {
        const assistantMessage = currentResponse.choices?.[0]?.message;

        if (!assistantMessage) {
          throw new Error("No response from LLM");
        }

        // Handle tool calls
        if (
          assistantMessage.tool_calls &&
          assistantMessage.tool_calls.length > 0
        ) {
          toolRounds++;
          consecutiveNonToolResponses = 0; // Reset counter when AI makes tool calls

          // Clean up tool call arguments before adding to conversation history
          // This prevents Ollama from rejecting malformed tool calls on subsequent API calls
          const cleanedToolCalls = assistantMessage.tool_calls.map(toolCall => {
            let argsString = sanitizeToolArguments(toolCall.function.arguments);

            return {
              ...toolCall,
              function: {
                ...toolCall.function,
                arguments: argsString
              }
            };
          });

          // Add assistant message to conversation
          this.messages.push({
            role: "assistant",
            content: assistantMessage.content || "(Calling tools to perform this request)",
            tool_calls: cleanedToolCalls,
          } as any);

          // Add assistant message to chat history
          const assistantToolCallEntry: ChatEntry = {
            type: "assistant",
            content: assistantMessage.content || "(Calling tools to perform this request)",
            timestamp: new Date(),
            tool_calls: assistantMessage.tool_calls,
          };
          this.chatHistory.push(assistantToolCallEntry);
          newEntries.push(assistantToolCallEntry);

          await this.contextManager.emitContextChange();

          // Create initial tool call entries to show tools are being executed
          // Use cleanedToolCalls to preserve arguments in chatHistory
          cleanedToolCalls.forEach((toolCall) => {
            const toolCallEntry = this.buildToolCallEntry(toolCall);
            this.chatHistory.push(toolCallEntry);
            newEntries.push(toolCallEntry);
          });

          // Execute tool calls and update the entries
          let toolIndex = 0;
          const completedToolCallIds = new Set<string>();

          try {
            for (const toolCall of cleanedToolCalls) {
              // Check for cancellation before executing each tool
              if (this.abortController?.signal.aborted) {
                console.error(`Tool execution cancelled after ${toolIndex}/${cleanedToolCalls.length} tools`);

                // Add cancelled responses for remaining uncompleted tools
                for (let i = toolIndex; i < cleanedToolCalls.length; i++) {
                  const remainingToolCall = cleanedToolCalls[i];
                  this.messages.push({
                    role: "tool",
                    content: "[Cancelled by user]",
                    tool_call_id: remainingToolCall.id,
                  });
                  completedToolCallIds.add(remainingToolCall.id);
                }

                throw new Error("Operation cancelled by user");
              }

              const result = await this.toolExecutor.executeTool(toolCall);

            // Update the existing tool_call entry with the result
            const entryIndex = this.chatHistory.findIndex(
              (entry) =>
                entry.type === "tool_call" && entry.toolCall?.id === toolCall.id
            );

            if (entryIndex !== -1) {
              const prevEntry = this.chatHistory[entryIndex];
              const updatedEntry: ChatEntry = {
                ...prevEntry,
                type: "tool_result",
                content: result.success
                  ? result.output || "Success"
                  : result.error || "Error occurred",
                toolResult: result,
                metadata: { ...(prevEntry.metadata || {}), rationale: result.rationale },
              };
              this.chatHistory[entryIndex] = updatedEntry;

              // Also update in newEntries for return value
              const newEntryIndex = newEntries.findIndex(
                (entry) =>
                  entry.type === "tool_call" &&
                  entry.toolCall?.id === toolCall.id
              );
              if (newEntryIndex !== -1) {
                newEntries[newEntryIndex] = updatedEntry;
              }
            }

            // Add tool result to messages with proper format (needed for AI context)
            this.messages.push({
              role: "tool",
              content: result.success
                ? result.output || "Success"
                : result.error || "Error",
              tool_call_id: toolCall.id,
            });
            completedToolCallIds.add(toolCall.id);
            await this.contextManager.emitContextChange();

            toolIndex++;
          }
          } finally {
            // Ensure ALL tool calls in this.messages have results, even if we crashed/errored
            for (const toolCall of cleanedToolCalls) {
              if (!completedToolCallIds.has(toolCall.id)) {
                this.messages.push({
                  role: "tool",
                  content: "[Error: Tool execution interrupted]",
                  tool_call_id: toolCall.id,
                });
              }
            }
          }

          // After all tool results are added, add any system messages from this tool round
          // System messages are added to chatHistory during tool execution (for display)
          // Now we add them to this.messages in the same order (after all tool results)
          // Find the most recent assistant message with tool_calls in chatHistory (search backwards)
          let assistantIndex = -1;
          for (let i = this.chatHistory.length - 1; i >= 0; i--) {
            const entry = this.chatHistory[i];
            if (entry.type === "assistant" && entry.tool_calls && entry.tool_calls.length > 0) {
              assistantIndex = i;
              break;
            }
          }
          if (assistantIndex !== -1) {
            // Collect system messages that appeared after this assistant message
            for (let i = assistantIndex + 1; i < this.chatHistory.length; i++) {
              const entry = this.chatHistory[i];
              const content = getTextContent(entry.content);
              if (entry.type === 'system' && content && content.trim()) {
                this.messages.push({
                  role: 'system',
                  content: content
                });
              }
              // Stop if we hit another assistant or user message (next turn)
              if (entry.type === 'assistant' || entry.type === 'user') {
                break;
              }
            }
          }

          // Get next response - this might contain more tool calls
          // Debug logging to diagnose tool_call/tool_result mismatch
          const debugLogPath = ChatHistoryManager.getDebugLogPath();
          const timestamp = new Date().toISOString();
          fs.appendFileSync(debugLogPath, `\n${timestamp} - [DEBUG] Messages before API call (${this.messages.length} messages):\n`);
          this.messages.forEach((msg, idx) => {
            const msgSummary: any = { idx, role: msg.role };
            if ((msg as any).tool_calls) msgSummary.tool_calls = (msg as any).tool_calls.map((tc: any) => tc.id);
            if ((msg as any).tool_call_id) msgSummary.tool_call_id = (msg as any).tool_call_id;
            fs.appendFileSync(debugLogPath, `  ${JSON.stringify(msgSummary)}\n`);
          });

          // Render system message with current variable state before sending to LLM
          this.renderSystemMessage();

          currentResponse = await this.llmClient.chat(
            this.messages,
            supportsTools ? await getAllLLMTools() : [],
            undefined,
            this.isGrokModel() && this.shouldUseSearchFor(message)
              ? { search_parameters: { mode: "auto" } }
              : { search_parameters: { mode: "off" } },
            this.temperature,
            this.abortController?.signal,
            this.maxTokens
          );
        } else {
          // No tool calls in this response - only add it if there's actual content
          let trimmedContent = assistantMessage.content?.trim();

          // If this was a rephrase with prefill, prepend the prefill text to the response
          if (trimmedContent && this.rephraseState?.prefillText) {
            trimmedContent = this.rephraseState.prefillText + trimmedContent;
          }

          // If a hook provided prefill, prepend it to the response
          const hookPrefillText = this.messageProcessor.getHookPrefillText();
          if (trimmedContent && hookPrefillText) {
            trimmedContent = hookPrefillText + trimmedContent;
            this.messageProcessor.clearHookPrefillText();
          }

          if (trimmedContent) {
            const responseEntry: ChatEntry = {
              type: "assistant",
              content: trimmedContent,
              timestamp: new Date(),
            };
            this.chatHistory.push(responseEntry);
            this.messages.push({
              role: "assistant",
              content: trimmedContent,
            });
            newEntries.push(responseEntry);

            // Update rephrase state with the new response index
            if (this.rephraseState && this.rephraseState.newResponseIndex === -1) {
              const newResponseIndex = this.chatHistory.length - 1;
              this.setRephraseState(
                this.rephraseState.originalAssistantMessageIndex,
                this.rephraseState.rephraseRequestIndex,
                newResponseIndex,
                this.rephraseState.messageType,
                this.rephraseState.prefillText
              );
            }

            // Save context and execute post-llmresponse hook
            await this.saveContextAndExecutePostLLMResponseHook(trimmedContent);
          }

          // TODO: HACK - This is a temporary fix to prevent duplicate responses.
          // We need a proper way for the bot to signal task completion, such as:
          // - A special tool call like "taskComplete()"
          // - A finish_reason indicator in the API response
          // - A structured response format that explicitly marks completion
          // For now, we break immediately after a substantial response to avoid
          // the cascade of duplicate responses caused by "give it one more chance" logic.

          // If the AI provided a substantial response (>SUBSTANTIAL_RESPONSE_THRESHOLD chars), task is complete
          if (assistantMessage.content && assistantMessage.content.trim().length > SUBSTANTIAL_RESPONSE_THRESHOLD) {
            break; // Task complete - bot gave a full response
          }

          // Short/empty response, give AI another chance
          // Render system message with current variable state before sending to LLM
          this.renderSystemMessage();

          currentResponse = await this.llmClient.chat(
            this.messages,
            supportsTools ? await getAllLLMTools() : [],
            undefined,
            this.isGrokModel() && this.shouldUseSearchFor(message)
              ? { search_parameters: { mode: "auto" } }
              : { search_parameters: { mode: "off" } },
            this.temperature,
            this.abortController?.signal,
            this.maxTokens
          );

          // Parse XML tool calls from followup response if present
          if (currentResponse.choices?.[0]?.message) {
            currentResponse.choices[0].message = this.messageProcessor.parseXMLToolCalls(currentResponse.choices[0].message);
          }

          const followupMessage = currentResponse.choices?.[0]?.message;
          if (!followupMessage?.tool_calls || followupMessage.tool_calls.length === 0) {
            break; // AI doesn't want to continue
          }
        }
      }

      if (toolRounds >= maxToolRounds) {
        const warningEntry: ChatEntry = {
          type: "assistant",
          content:
            "Maximum tool execution rounds reached. Stopping to prevent infinite loops.",
          timestamp: new Date(),
        };
        this.chatHistory.push(warningEntry);
        newEntries.push(warningEntry);
      }

      // Mark first message as processed so subsequent messages use cached tools
      this.firstMessageProcessed = true;

      // Check if tool support changed during first message processing
      // If model doesn't support tools, regenerate system message without tool list
      const supportsToolsAfter = this.llmClient.getSupportsTools();
      if (!supportsToolsAfter && supportsTools) {
        // Tool support was disabled during first message - regenerate system message
        await this.buildSystemMessage();
      }

      return newEntries;
    } catch (error: any) {
      // Check if context is too large (413 error when vision already disabled)
      if (error.message && error.message.startsWith('CONTEXT_TOO_LARGE:')) {
        const beforeCount = this.chatHistory.length;
        this.compactContext(20);
        const afterCount = this.chatHistory.length;
        const removedCount = beforeCount - afterCount;

        const compactEntry: ChatEntry = {
          type: "system",
          content: `Context was too large for backend. Automatically compacted: removed ${removedCount} older messages, keeping last 20 messages. Please retry your request.`,
          timestamp: new Date(),
        };
        this.chatHistory.push(compactEntry);

        // Mark first message as processed
        this.firstMessageProcessed = true;

        return userEntry ? [userEntry, compactEntry] : [compactEntry];
      }

      const errorEntry: ChatEntry = {
        type: "assistant",
        content: `Sorry, I encountered an error: ${error.message}`,
        timestamp: new Date(),
      };
      this.chatHistory.push(errorEntry);

      // Mark first message as processed even on error
      this.firstMessageProcessed = true;

      return userEntry ? [userEntry, errorEntry] : [errorEntry];
    }
  }





  /**
   * Process a user message with real-time streaming response.
   *
   * This is the main streaming message processing method that yields
   * chunks of data as the conversation progresses. Provides real-time
   * updates for:
   * - User message processing
   * - AI response streaming (content as it's generated)
   * - Tool execution progress
   * - Token count updates
   * - System messages from hooks
   *
   * ## Streaming Flow
   *
   * 1. **Setup**: Process user message, yield user entry
   * 2. **Agent Loop**: Stream AI responses and execute tools
   *    - Stream AI response content in real-time
   *    - Yield tool calls when detected
   *    - Execute tools and yield results
   *    - Continue until completion
   * 3. **Completion**: Yield final token counts and done signal
   *
   * ## Chunk Types
   *
   * - `user_message`: Initial user message entry
   * - `content`: Streaming AI response content
   * - `tool_calls`: Tool calls detected in AI response
   * - `tool_result`: Results from tool execution
   * - `token_count`: Updated token usage
   * - `done`: Processing complete
   *
   * @param message - The user message to process
   * @yields StreamingChunk objects with real-time updates
   * @throws {Error} If streaming fails critically
   */
  async *processUserMessageStream(
    message: string
  ): AsyncGenerator<StreamingChunk, void, unknown> {
    this.abortController = new AbortController();
    const {isRephraseCommand, messageType, messageToSend, prefillText} = await this.messageProcessor.setupRephraseCommand(message);
    await this.cleanupIncompleteToolCalls();
    Variable.clearOneShot();

    // Execute postUserInput hook
    const postUserInputHookPath = getSettingsManager().getPostUserInputHook();
    if (postUserInputHookPath) {
      const hookResult = await executeOperationHook(
        postUserInputHookPath,
        "postUserInput",
        { USER_MESSAGE: message },
        30000,
        false,
        this.getCurrentTokenCount(),
        this.getMaxContextSize()
      );

      if (hookResult.approved && hookResult.commands) {
        const results = applyHookCommands(hookResult.commands);
        applyEnvVariables(results.env);
        const seenVars = new Set<string>();
        for (const {name, value} of results.promptVars) {
          if (seenVars.has(name)) {
            Variable.append(name, value);
          } else {
            Variable.set(name, value);
            seenVars.add(name);
          }
        }
        if (results.prefill) {
          this.messageProcessor.setHookPrefillText(results.prefill);
        }
        if (results.maxContext !== undefined) {
          this.maxContextSize = results.maxContext;
        }
      }
    }

    const maxToolRounds = this.maxToolRounds; // Prevent infinite loops
    let toolRounds = 0;
    let totalOutputTokens = 0;
    let lastTokenUpdate = 0;
    let consecutiveNonToolResponses = 0;

    try {
      // Execute preLLMResponse hook before assembling message
      const hookPath = getSettingsManager().getPreLLMResponseHook();
      if (hookPath) {
        const hookResult = await executeOperationHook(
          hookPath,
          "preLLMResponse",
          { USER_MESSAGE: message },
          30000,
          false,
          this.getCurrentTokenCount(),
          this.getMaxContextSize()
        );

        if (hookResult.approved && hookResult.commands) {
          const results = applyHookCommands(hookResult.commands);
          applyEnvVariables(results.env);
          const seenVars = new Set<string>();
          for (const {name, value} of results.promptVars) {
            if (seenVars.has(name)) {
              Variable.append(name, value);
            } else {
              Variable.set(name, value);
              seenVars.add(name);
            }
          }
          if (results.prefill) {
            this.messageProcessor.setHookPrefillText(results.prefill);
          }
        }
      }

      // Parse and assemble message AFTER hooks have set USER:* variables
      const {parsed, assembledMessage} = await this.messageProcessor.parseAndAssembleMessage(messageToSend);
      const {userEntry, messageContent} = this.messageProcessor.prepareMessageContent(messageType, assembledMessage, parsed, messageToSend, this.llmClient.getSupportsVision());

      this.chatHistory.push(userEntry);
      if (messageType === "user") {
        this.messages.push({ role: "user", content: messageContent });
      } else {
        this.messages.push({ role: "system", content: typeof messageContent === "string" ? messageContent : messageToSend });
      }
      await this.contextManager.emitContextChange();

      yield {
        type: "user_message",
        userEntry: userEntry,
      };

      // Calculate input tokens
      let inputTokens = this.tokenCounter.countMessageTokens(
        this.messages as any
      );
      yield {
        type: "token_count",
        tokenCount: inputTokens,
      };
      // Always fetch tools fresh - getAllLLMTools() handles lazy refresh internally
      const supportsTools = this.llmClient.getSupportsTools();

      // Agent loop - continue until no more tool calls or max rounds reached
      while (toolRounds < maxToolRounds) {
        // Check if operation was cancelled
        if (this.abortController?.signal.aborted) {
          yield {
            type: "content",
            content: "\n\n[Operation cancelled by user]",
          };
          yield { type: "done" };
          return;
        }

        // Update system message with current token count
        if (this.messages.length > 0 && this.messages[0].role === 'system' && typeof this.messages[0].content === 'string') {
          this.messages[0].content = this.messages[0].content.replace(/Current conversation token usage: .*/, `Current conversation token usage: ${inputTokens}`);
        }

        // Stream response and accumulate

        // If rephrase or hook returned prefill text, add the assistant message now
        const rephraseText = this.rephraseState?.prefillText;
        const hookPrefillText = this.messageProcessor.getHookPrefillText();
        if (rephraseText) {
          this.messages.push({
            role: "assistant",
            content: rephraseText
          });
        } else if (hookPrefillText) {
          this.messages.push({
            role: "assistant",
            content: hookPrefillText
          });
        }

        // Render system message with current variable state before sending to LLM
        this.renderSystemMessage();

        const stream = this.llmClient.chatStream(
          this.messages,
          supportsTools ? await getAllLLMTools() : [],
          undefined,
          this.isGrokModel() && this.shouldUseSearchFor(message)
            ? { search_parameters: { mode: "auto" } }
            : { search_parameters: { mode: "off" } },
          this.temperature,
          this.abortController?.signal,
          this.maxTokens
        );
        let accumulatedMessage: any = {};
        let accumulatedContent = "";
        let tool_calls_yielded = false;
        let streamFinished = false;
        let insideThinkTag = false;

        // If this is a rephrase with prefill, yield the prefill text first and add to accumulated content
        if (this.rephraseState?.prefillText) {
          yield {
            type: "content",
            content: this.rephraseState.prefillText,
          };
          accumulatedContent = this.rephraseState.prefillText;
        }

        try {
          for await (const chunk of stream) {
            // Check for cancellation in the streaming loop
            if (this.abortController?.signal.aborted) {
              yield {
                type: "content",
                content: "\n\n[Operation cancelled by user]",
              };
              yield { type: "done" };
              return;
            }

            if (!chunk.choices?.[0]) continue;

            // Check if stream is finished (Venice sends garbage after this)
            if (chunk.choices?.[0]?.finish_reason === "stop" || chunk.choices?.[0]?.finish_reason === "tool_calls") {
              streamFinished = true;
            }

            // Accumulate the message using reducer
            accumulatedMessage = this.messageProcessor.messageReducer(accumulatedMessage, chunk);

            // Check for tool calls - yield when we have complete tool calls with function names
            if (!tool_calls_yielded && accumulatedMessage.tool_calls?.length > 0) {
              // Check if we have at least one complete tool call with a function name
              const hasCompleteTool = accumulatedMessage.tool_calls.some(
                (tc: any) => tc.function?.name
              );
              if (hasCompleteTool) {
                yield {
                  type: "tool_calls",
                  tool_calls: accumulatedMessage.tool_calls,
                };
                tool_calls_yielded = true;
              }
            }

            // Stream content as it comes (but ignore content after stream is finished to avoid Venice garbage)
            if (chunk.choices[0].delta?.content && !streamFinished) {
              let deltaContent = chunk.choices[0].delta.content;

              // Handle thinking tags that may span multiple chunks
              // First, remove complete <think>...</think> blocks within this chunk
              deltaContent = deltaContent.replace(/<think>[\s\S]*?<\/think>/g, '');

              // Check for opening <think> tag
              if (deltaContent.includes('<think>')) {
                insideThinkTag = true;
                // Remove everything from <think> onwards in this chunk
                deltaContent = deltaContent.substring(0, deltaContent.indexOf('<think>'));
              }

              // If we're inside a think tag, remove everything up to and including </think>
              if (insideThinkTag) {
                if (deltaContent.includes('</think>')) {
                  // Found closing tag - remove everything up to and including it
                  const closeIndex = deltaContent.indexOf('</think>');
                  deltaContent = deltaContent.substring(closeIndex + 8); // 8 = length of '</think>'
                  insideThinkTag = false;
                } else {
                  // Still inside think block - remove entire chunk
                  deltaContent = '';
                }
              }

              // Skip completely empty chunks after filtering (but keep spaces!)
              if (deltaContent === '') continue;

              accumulatedContent += deltaContent;

              // Update token count in real-time including accumulated content and any tool calls
              const currentOutputTokens =
                this.tokenCounter.estimateStreamingTokens(accumulatedContent) +
                (accumulatedMessage.tool_calls
                  ? this.tokenCounter.countTokens(
                      JSON.stringify(accumulatedMessage.tool_calls)
                    )
                  : 0);
              totalOutputTokens = currentOutputTokens;

              yield {
                type: "content",
                content: deltaContent,
              };

              // Emit token count update
              const now = Date.now();
              if (now - lastTokenUpdate > TOKEN_UPDATE_INTERVAL_MS) {
                lastTokenUpdate = now;
                yield {
                  type: "token_count",
                  tokenCount: inputTokens + totalOutputTokens,
                };
              }
            }
          }
        } catch (streamError: any) {
          // Check if stream was aborted
          if (this.abortController?.signal.aborted || streamError.name === 'AbortError' || streamError.code === 'ABORT_ERR') {
            yield {
              type: "content",
              content: "\n\n[Operation cancelled by user]",
            };
            yield { type: "done" };
            return;
          }
          // Re-throw other errors to be caught by outer catch
          throw streamError;
        }

        // Parse XML tool calls from accumulated message if present
        accumulatedMessage = this.messageProcessor.parseXMLToolCalls(accumulatedMessage);

        // Clean up tool call arguments before adding to conversation history
        // This prevents Ollama from rejecting malformed tool calls on subsequent API calls
        const cleanedToolCalls = accumulatedMessage.tool_calls?.map(toolCall => {
          let argsString = sanitizeToolArguments(toolCall.function.arguments);

          return {
            ...toolCall,
            function: {
              ...toolCall.function,
              arguments: argsString
            }
          };
        });

        // Add accumulated message to conversation for API context
        this.messages.push({
          role: "assistant",
          content: accumulatedMessage.content || "(Calling tools to perform this request)",
          tool_calls: cleanedToolCalls,
        } as any);

        // Add assistant message to chat history
        const assistantEntry: ChatEntry = {
          type: "assistant",
          content: accumulatedMessage.content || "(Calling tools to perform this request)",
          timestamp: new Date(),
          tool_calls: accumulatedMessage.tool_calls,
        };
        this.chatHistory.push(assistantEntry);

        await this.contextManager.emitContextChange();

        // Update rephrase state if this is a final response (no tool calls)
        if (this.rephraseState && this.rephraseState.newResponseIndex === -1 && (!accumulatedMessage.tool_calls || accumulatedMessage.tool_calls.length === 0)) {
          const newResponseIndex = this.chatHistory.length - 1;
          this.setRephraseState(
            this.rephraseState.originalAssistantMessageIndex,
            this.rephraseState.rephraseRequestIndex,
            newResponseIndex,
            this.rephraseState.messageType
          );
        }

        // Handle tool calls if present
        if (accumulatedMessage.tool_calls?.length > 0) {
          toolRounds++;

          // Only yield tool_calls if we haven't already yielded them during streaming
          if (!tool_calls_yielded) {
            yield {
              type: "tool_calls",
              tool_calls: accumulatedMessage.tool_calls,
            };
          }

          // Add tool_call entries to chatHistory so they persist through UI sync
          // Use cleanedToolCalls to preserve arguments in chatHistory
          cleanedToolCalls.forEach((toolCall) => {
            this.chatHistory.push(this.buildToolCallEntry(toolCall));
          });

          // Execute tools
          let toolIndex = 0;
          const completedToolCallIds = new Set<string>();

          try {
            for (const toolCall of cleanedToolCalls) {
              // Check for cancellation before executing each tool
              if (this.abortController?.signal.aborted) {
                console.error(`Tool execution cancelled after ${toolIndex}/${cleanedToolCalls.length} tools`);

                // Add cancelled responses for remaining uncompleted tools
                for (let i = toolIndex; i < cleanedToolCalls.length; i++) {
                  const remainingToolCall = cleanedToolCalls[i];
                  this.messages.push({
                    role: "tool",
                    content: "[Cancelled by user]",
                    tool_call_id: remainingToolCall.id,
                  });
                  completedToolCallIds.add(remainingToolCall.id);
                }

                yield {
                  type: "content",
                  content: "\n\n[Operation cancelled by user]",
                };
                yield { type: "done" };
                return;
              }

              // Capture chatHistory length before tool execution to detect new system messages
              const chatHistoryLengthBefore = this.chatHistory.length;

              const result = await this.toolExecutor.executeTool(toolCall);

            // Collect any new system messages added during tool execution (from hooks)
            const newSystemMessages: ChatEntry[] = [];
            for (let i = chatHistoryLengthBefore; i < this.chatHistory.length; i++) {
              if (this.chatHistory[i].type === "system") {
                newSystemMessages.push(this.chatHistory[i]);
              }
            }

            yield {
              type: "tool_result",
              toolCall,
              toolResult: result,
              systemMessages: newSystemMessages.length > 0 ? newSystemMessages : undefined,
            };

            // Update the tool_call entry in chatHistory to tool_result
            const entryIndex = this.chatHistory.findIndex(
              (entry) => entry.type === "tool_call" && entry.toolCall?.id === toolCall.id
            );
            if (entryIndex !== -1) {
              const prevEntry = this.chatHistory[entryIndex];
              this.chatHistory[entryIndex] = {
                ...prevEntry,
                type: "tool_result",
                content: result.success
                  ? (result.output?.trim() || "Success")
                  : (result.error?.trim() || "Error occurred"),
                toolResult: result,
                metadata: { ...(prevEntry.metadata || {}), rationale: result.rationale },
              };
            }

            // Add tool result with proper format (needed for AI context)
            this.messages.push({
              role: "tool",
              content: result.success
                ? result.output || "Success"
                : result.error || "Error",
              tool_call_id: toolCall.id,
            });
            completedToolCallIds.add(toolCall.id);

            toolIndex++;
          }
          } finally {
            // Ensure ALL tool calls in this.messages have results, even if we crashed/errored
            for (const toolCall of cleanedToolCalls) {
              if (!completedToolCallIds.has(toolCall.id)) {
                this.messages.push({
                  role: "tool",
                  content: "[Error: Tool execution interrupted]",
                  tool_call_id: toolCall.id,
                });
              }
            }
          }

          // After all tool results are added, add any system messages from this tool round
          // System messages are added to chatHistory during tool execution (for display)
          // Now we add them to this.messages in the same order (after all tool results)
          // Find the most recent assistant message with tool_calls in chatHistory (search backwards)
          let assistantIndex = -1;
          for (let i = this.chatHistory.length - 1; i >= 0; i--) {
            const entry = this.chatHistory[i];
            if (entry.type === "assistant" && entry.tool_calls && entry.tool_calls.length > 0) {
              assistantIndex = i;
              break;
            }
          }
          if (assistantIndex !== -1) {
            // Collect system messages that appeared after this assistant message
            for (let i = assistantIndex + 1; i < this.chatHistory.length; i++) {
              const entry = this.chatHistory[i];
              const content = getTextContent(entry.content);
              if (entry.type === 'system' && content && content.trim()) {
                this.messages.push({
                  role: 'system',
                  content: content
                });
              }
              // Stop if we hit another assistant or user message (next turn)
              if (entry.type === 'assistant' || entry.type === 'user') {
                break;
              }
            }
          }

          // Update token count after processing all tool calls to include tool results
          inputTokens = this.tokenCounter.countMessageTokens(
            this.messages as any
          );
          // Final token update after tools processed
          yield {
            type: "token_count",
            tokenCount: inputTokens + totalOutputTokens,
          };

          // Continue the loop to get the next response (which might have more tool calls)
        } else {
          // No tool calls -- this is the final response, fire the hook once
          await this.saveContextAndExecutePostLLMResponseHook(
            accumulatedMessage.content,
            accumulatedMessage.tool_calls
          );
          break;
        }
      }

      if (toolRounds >= maxToolRounds) {
        yield {
          type: "content",
          content:
            "\n\nMaximum tool execution rounds reached. Stopping to prevent infinite loops.",
        };
      }

      // Mark first message as processed so subsequent messages use cached tools
      this.firstMessageProcessed = true;

      // Check if tool support changed during first message processing
      // If model doesn't support tools, regenerate system message without tool list
      const supportsToolsAfter = this.llmClient.getSupportsTools();
      if (!supportsToolsAfter && supportsTools) {
        // Tool support was disabled during first message - regenerate system message
        await this.buildSystemMessage();
      }

      yield { type: "done" };
    } catch (error: any) {
      // Check if this was a cancellation (check both abort signal and error name)
      if (this.abortController?.signal.aborted || error.name === 'AbortError' || error.code === 'ABORT_ERR') {
        yield {
          type: "content",
          content: "\n\n[Operation cancelled by user]",
        };
        yield { type: "done" };
        return;
      }

      // Check if context is too large (413 error when vision already disabled)
      if (error.message && error.message.startsWith('CONTEXT_TOO_LARGE:')) {
        const beforeCount = this.chatHistory.length;
        this.compactContext(20);
        const afterCount = this.chatHistory.length;
        const removedCount = beforeCount - afterCount;

        const compactEntry: ChatEntry = {
          type: "system",
          content: `Context was too large for backend. Automatically compacted: removed ${removedCount} older messages, keeping last 20 messages. Please retry your request.`,
          timestamp: new Date(),
        };
        this.chatHistory.push(compactEntry);
        yield {
          type: "content",
          content: getTextContent(compactEntry.content),
        };
        yield { type: "done" };
        return;
      }

      const errorEntry: ChatEntry = {
        type: "assistant",
        content: `Sorry, I encountered an error: ${error.message}`,
        timestamp: new Date(),
      };
      this.chatHistory.push(errorEntry);
      yield {
        type: "content",
        content: getTextContent(errorEntry.content),
      };

      // Mark first message as processed even on error
      this.firstMessageProcessed = true;

      yield { type: "done" };
    } finally {
      // Clean up abort controller
      this.abortController = null;
    }
  }

  /**
   * Apply default parameter values for tools
   * This ensures the approval hook sees the same parameters that will be used during execution
   */

  /**
   * Validate tool arguments against the tool's schema
   * Returns null if valid, or an error message if invalid
   */



  /**
   * Get a copy of the current chat history.
   * @returns Array of chat entries (defensive copy)
   */
  getChatHistory(): ChatEntry[] {
    return [...this.chatHistory];
  }

  /**
   * Set the chat history to a new array of entries.
   * @param history - New chat history entries
   */
  setChatHistory(history: ChatEntry[]): void {
    this.chatHistory = [...history];
  }

  /**
   * Get the current system prompt.
   * @returns The system prompt string
   */
  getSystemPrompt(): string {
    // Render system message with current variable state before returning
    this.renderSystemMessage();
    return this.systemPrompt;
  }

  /**
   * Set a new system prompt and update the first message.
   * @param prompt - Ignored (deprecated) - system prompt is always rendered from variables
   */
  setSystemPrompt(prompt: string): void {
    // System prompt is always dynamic - render from current variable state
    this.renderSystemMessage();
  }

  /**
   * Get a copy of the current API messages array.
   * @returns Array of LLM messages (defensive copy)
   */
  getMessages(): any[] {
    return [...this.messages];
  }

  /**
   * Get the current token count for the conversation.
   * @returns Number of tokens in the current message context
   */
  getCurrentTokenCount(): number {
    return this.tokenCounter.countMessageTokens(this.messages as any);
  }

  /**
   * Get the maximum context size for the current model.
   * @returns Maximum number of tokens supported
   * @todo Make this model-specific for different context windows
   */
  getMaxContextSize(): number {
    return this.maxContextSize;
  }

  /**
   * Get the current context usage as a percentage.
   * @returns Percentage of context window used (0-100)
   */
  getContextUsagePercent(): number {
    return this.contextManager.getContextUsagePercent();
  }

  /**
   * Convert the conversation context to markdown format for viewing.
   *
   * Creates a human-readable markdown representation of the conversation
   * including:
   * - Header with context file path and token usage
   * - Numbered messages with timestamps
   * - Formatted tool calls and results
   * - Proper attribution (User/Assistant/System)
   *
   * Format: (N) Name (role) - timestamp
   *
   * @returns Promise resolving to markdown-formatted conversation
   */
  async convertContextToMarkdown(): Promise<string> {
    const lines: string[] = [];

    // Header
    const { ChatHistoryManager } = await import("../utils/chat-history-manager.js");
    const historyManager = ChatHistoryManager.getInstance();
    const contextFilePath = historyManager.getContextFilePath();

    lines.push("# Conversation Context");
    lines.push(`Context File: ${contextFilePath}`);
    lines.push(`Session: ${process.env.ZDS_AI_AGENT_SESSION || "N/A"}`);
    lines.push(`Tokens: ${this.getCurrentTokenCount()} / ${this.getMaxContextSize()} (${this.getContextUsagePercent().toFixed(1)}%)`);
    lines.push("");
    lines.push("---");
    lines.push("");

    // Get agent name from environment or default
    const agentName = process.env.ZDS_AI_AGENT_BOT_NAME || "Assistant";
    const userName = process.env.ZDS_AI_AGENT_MESSAGE_AUTHOR || "User";

    // Process messages
    this.chatHistory.forEach((entry, index) => {
      const msgNum = index + 1;
      const timestamp = entry.timestamp.toLocaleTimeString();

      if (entry.type === 'user') {
        lines.push(`(${msgNum}) ${userName} (user) - ${timestamp}`);
        lines.push(getTextContent(entry.content) || "");
        lines.push("");
      } else if (entry.type === 'assistant') {
        lines.push(`(${msgNum}) ${agentName} (assistant) - ${timestamp}`);
        lines.push(getTextContent(entry.content) || "");
        lines.push("");
      } else if (entry.type === 'system') {
        lines.push(`(${msgNum}) System (system) - ${timestamp}`);
        lines.push(getTextContent(entry.content) || "");
        lines.push("");
      } else if (entry.type === 'tool_call') {
        const toolCall = entry.toolCall;
        const toolName = toolCall?.function?.name || "unknown";
        const params = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
        lines.push(`(${msgNum}) ${agentName} (tool_call: ${toolName}) - ${timestamp}`);
        lines.push(`Parameters: ${JSON.stringify(params, null, 2)}`);
        lines.push("");
      } else if (entry.type === 'tool_result') {
        const toolCall = entry.toolCall;
        const toolName = toolCall?.function?.name || "unknown";
        lines.push(`(${msgNum}) System (tool_result: ${toolName}) - ${timestamp}`);
        lines.push(getTextContent(entry.content) || "");
        lines.push("");
      }
    });

    return lines.join("\n");
  }

  /**
   * Get the current persona setting.
   * @returns Current persona string
   */
  getPersona(): string {
    return this.persona;
  }

  /**
   * Get the current persona display color.
   * @returns Color name for persona display
   */
  getPersonaColor(): string {
    return this.personaColor;
  }

  /**
   * Get the current mood setting.
   * @returns Current mood string
   */
  getMood(): string {
    return this.mood;
  }

  /**
   * Get the current mood display color.
   * @returns Color name for mood display
   */
  getMoodColor(): string {
    return this.moodColor;
  }

  /**
   * Get the current active task.
   * @returns Current active task string
   */
  getActiveTask(): string {
    return this.activeTask;
  }

  /**
   * Get the current active task action.
   * @returns Current task action string
   */
  getActiveTaskAction(): string {
    return this.activeTaskAction;
  }

  /**
   * Get the current active task display color.
   * @returns Color name for task display
   */
  getActiveTaskColor(): string {
    return this.activeTaskColor;
  }

  /**
   * Set a pending context edit session for file-based context editing.
   * @param tmpJsonPath - Path to temporary JSON file
   * @param contextFilePath - Path to actual context file
   */
  setPendingContextEditSession(tmpJsonPath: string, contextFilePath: string): void {
    this.pendingContextEditSession = { tmpJsonPath, contextFilePath };
  }

  /**
   * Get the current pending context edit session.
   * @returns Edit session info or null if none pending
   */
  getPendingContextEditSession(): { tmpJsonPath: string; contextFilePath: string } | null {
    return this.pendingContextEditSession;
  }

  /**
   * Clear the pending context edit session.
   */
  clearPendingContextEditSession(): void {
    this.pendingContextEditSession = null;
  }

  /**
   * Set the rephrase state for message editing operations.
   * @param originalAssistantMessageIndex - Index of original assistant message
   * @param rephraseRequestIndex - Index of rephrase request
   * @param newResponseIndex - Index of new response (-1 if not yet created)
   * @param messageType - Type of message being rephrased
   * @param prefillText - Optional prefill text for the response
   */
  setRephraseState(originalAssistantMessageIndex: number, rephraseRequestIndex: number, newResponseIndex: number, messageType: "user" | "system", prefillText?: string): void {
    this.rephraseState = { originalAssistantMessageIndex, rephraseRequestIndex, newResponseIndex, messageType, prefillText };
  }

  /**
   * Get the current rephrase state.
   * @returns Rephrase state info or null if none active
   */
  getRephraseState(): { originalAssistantMessageIndex: number; rephraseRequestIndex: number; newResponseIndex: number; messageType: "user" | "system"; prefillText?: string } | null {
    return this.rephraseState;
  }

  /**
   * Clear the current rephrase state.
   */
  clearRephraseState(): void {
    this.rephraseState = null;
  }

  /**
   * Set the agent's persona with optional color.
   *
   * Executes the persona hook if configured and updates the agent's
   * persona state on success.
   *
   * @param persona - The persona description
   * @param color - Optional display color (defaults to "white")
   * @returns Promise resolving to success/error result
   */
  async setPersona(persona: string, color?: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.hookManager.setPersona(persona, color);
    if (result.success) {
      this.persona = persona;
      this.personaColor = color || "white";
    }
    return result;
  }

  /**
   * Set the agent's mood with optional color.
   *
   * Executes the mood hook if configured and updates the agent's
   * mood state on success.
   *
   * @param mood - The mood description
   * @param color - Optional display color (defaults to "white")
   * @returns Promise resolving to success/error result
   */
  async setMood(mood: string, color?: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.hookManager.setMood(mood, color);
    if (result.success) {
      this.mood = mood;
      this.moodColor = color || "white";
    }
    return result;
  }

  /**
   * Start an active task with specified action and color.
   *
   * Executes the task start hook if configured and updates the agent's
   * task state on success.
   *
   * @param activeTask - The task description
   * @param action - The current action within the task
   * @param color - Optional display color (defaults to "white")
   * @returns Promise resolving to success/error result
   */
  async startActiveTask(activeTask: string, action: string, color?: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.hookManager.startActiveTask(activeTask, action, color);
    if (result.success) {
      this.activeTask = activeTask;
      this.activeTaskAction = action;
      this.activeTaskColor = color || "white";
    }
    return result;
  }

  /**
   * Transition the active task to a new action/status.
   *
   * Updates the current task action without changing the task itself.
   *
   * @param action - The new action description
   * @param color - Optional display color (defaults to current color)
   * @returns Promise resolving to success/error result
   */
  async transitionActiveTaskStatus(action: string, color?: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.hookManager.transitionActiveTaskStatus(action, color);
    if (result.success) {
      this.activeTaskAction = action;
      this.activeTaskColor = color || this.activeTaskColor;
    }
    return result;
  }

  /**
   * Stop the current active task with reason and documentation.
   *
   * Executes the task stop hook if configured and clears the agent's
   * task state on success.
   *
   * @param reason - Reason for stopping the task
   * @param documentationFile - Path to documentation file
   * @param color - Optional display color (defaults to "white")
   * @returns Promise resolving to success/error result
   */
  async stopActiveTask(reason: string, documentationFile: string, color?: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.hookManager.stopActiveTask(reason, documentationFile, color);
    if (result.success) {
      this.activeTask = "";
      this.activeTaskAction = "";
      this.activeTaskColor = "white";
    }
    return result;
  }

  /**
   * Delegation method for hook processing (used by ToolExecutor).
   *
   * Processes hook results through the HookManager to handle commands,
   * variable transformations, and other hook-specific logic.
   *
   * @param hookResult - Result object from hook execution
   * @param envKey - Optional environment key for variable transformation
   * @returns Promise resolving to processing result
   */
  async processHookResult(hookResult: { commands?: any[] }, envKey?: string): Promise<{ success: boolean; transformedValue?: string }> {
    return await this.hookManager['processHookResult'](hookResult, envKey);
  }

  /**
   * Execute a shell command through the ZSH tool.
   *
   * @param command - Shell command to execute
   * @param skipConfirmation - Whether to skip confirmation prompts
   * @returns Promise resolving to tool execution result
   */
  async executeCommand(command: string, skipConfirmation: boolean = false): Promise<ToolResult> {
    return await this.zsh.execute(command, 30000, skipConfirmation);
  }

  /**
   * Get the current LLM model name.
   * @returns Current model identifier
   */
  getCurrentModel(): string {
    return this.llmClient.getCurrentModel();
  }

  /**
   * Set a new LLM model and update related components.
   *
   * This method:
   * - Updates the LLM client model
   * - Resets vision support flag
   * - Updates the token counter for the new model
   * - Handles model name suffixes (e.g., :nothinking)
   *
   * @param model - New model identifier
   */
  setModel(model: string): void {
    this.llmClient.setModel(model);
    // Reset supportsVision flag for new model
    this.llmClient.setSupportsVision(true);
    // Update token counter for new model (strip :nothinking suffix)
    this.tokenCounter.dispose();
    const modelName = this.llmClient.getCurrentModel();
    const cleanModel = modelName.endsWith(':nothinking')
      ? modelName.slice(0, -':nothinking'.length)
      : modelName;
    this.tokenCounter = createTokenCounter(cleanModel);
  }

  /**
   * Get the backend name (e.g., "grok", "openai").
   * @returns Backend identifier string
   */
  getBackend(): string {
    // Just return the backend name from the client (no detection)
    return this.llmClient.getBackendName();
  }

  /**
   * Save context to disk and execute post-llmresponse hook.
   * This ensures the hook has access to the complete conversation including the latest response.
   *
   * @param content - The assistant message content
   * @param toolCalls - Optional array of tool calls made by the assistant
   */
  private async saveContextAndExecutePostLLMResponseHook(
    content: any,
    toolCalls?: any[]
  ): Promise<void> {
    // Save context to disk before calling post-llmresponse hook
    const historyManager = ChatHistoryManager.getInstance();
    const sessionState = this.sessionManager.getSessionState();
    historyManager.saveContext(this.systemPrompt, this.chatHistory, sessionState);
    historyManager.saveMessages(this.messages);

    // Execute postLLMResponse hook (now that response is saved to context.json)
    const postLLMResponseHookPath = getSettingsManager().getPostLLMResponseHook();
    if (postLLMResponseHookPath) {
      const hookResult = await executeOperationHook(
        postLLMResponseHookPath,
        "postLLMResponse",
        {
          LLM_RESPONSE: getTextContent(content),
          TOOL_CALLS: JSON.stringify(toolCalls || [])
        },
        30000,
        false,
        this.getCurrentTokenCount(),
        this.getMaxContextSize()
      );

      if (hookResult.approved && hookResult.commands) {
        await this.processHookResult(hookResult);
      }
    }
  }

  /**
   * Abort the current operation if one is in progress.
   *
   * This will cancel streaming responses and tool execution.
   */
  abortCurrentOperation(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Clear the conversation cache and reinitialize the agent.
   *
   * This method:
   * - Backs up current conversation to timestamped files
   * - Clears chat history and messages
   * - Resets context warnings and processing flags
   * - Re-executes startup and instance hooks
   * - Saves the cleared state
   * - Emits context change events
   *
   * Used when context becomes too large or user requests a fresh start.
   */
  async clearCache(): Promise<void> {
    const { ChatHistoryManager } = await import("../utils/chat-history-manager.js");
    const { executeStartupHook } = await import("../utils/startup-hook.js");
    const { executeOperationHook, applyHookCommands } = await import("../utils/hook-executor.js");
    const historyManager = ChatHistoryManager.getInstance();

    // Backup current context to timestamped files
    historyManager.backupHistory();

    // Clear in place to preserve ContextManager's array references
    this.chatHistory.length = 0;
    this.messages.length = 0;
    this.contextManager.resetContextWarnings();
    this.firstMessageProcessed = false;

    // Add temporary system message (will be replaced by initialize())
    this.messages.push({
      role: "system",
      content: "Initializing...",
    });
    this.chatHistory.push({
      type: "system",
      content: "Initializing...",
      timestamp: new Date(),
    });

    try {
      // Re-execute startup hook to get fresh output
      this.startupHookOutput = await executeStartupHook();

      // Reinitialize with system message and startup hook
      // Instance hook runs automatically at end of initialize()
      await this.initialize();
    } catch (error) {
      console.error("Error during initialize() in clearCache():", error);
      // Continue anyway - we still want to save the cleared state
    }

    // Save the cleared state FIRST before emitting (in case emit causes exit)
    const sessionState = this.getSessionState();
    historyManager.saveContext(this.systemPrompt, this.chatHistory, sessionState);
    historyManager.saveMessages(this.messages);

    // Emit context change WITHOUT calling addContextWarningIfNeeded (to avoid recursive clearCache)
    const percent = this.getContextUsagePercent();
    this.emit('contextChange', {
      current: this.getCurrentTokenCount(),
      max: this.getMaxContextSize(),
      percent
    });
    // Note: Intentionally NOT calling addContextWarningIfNeeded here to prevent recursion
  }

  /**
   * Get current session state for persistence.
   *
   * Collects all session-related state including:
   * - Model and backend configuration
   * - Persona, mood, and task settings
   * - Context usage statistics
   * - API key environment variable
   *
   * @returns Complete session state object
   */
  getSessionState(): SessionState {
    const state = this.sessionManager.getSessionState();
    // Add context values that SessionManager can't access
    state.contextCurrent = this.getCurrentTokenCount();
    state.contextMax = this.getMaxContextSize();
    return state;
  }

  /**
   * Restore session state from persistence.
   *
   * Restores all session-related state including:
   * - Model and backend configuration
   * - Persona, mood, and task settings
   * - Token counter and API client setup
   *
   * @param state - Session state to restore
   */
  async restoreSessionState(state: SessionState): Promise<void> {
    return await this.sessionManager.restoreSessionState(state);
  }

  /**
   * Compact conversation context by keeping system prompt and last N messages.
   *
   * Reduces context size when it grows too large for the backend to handle.
   * Removes older messages while preserving the system prompt and recent context.
   *
   * @param keepLastMessages - Number of recent messages to keep (default: 20)
   * @returns Number of messages removed
   */
  compactContext(keepLastMessages: number = 20): number {
    return this.contextManager.compactContext(keepLastMessages);
  }

  /**
   * Get all tool instances and their class names for display purposes.
   *
   * Uses reflection to find all tool instances and extract their
   * class names and handled method names for introspection.
   *
   * @returns Array of tool info objects with class names and methods
   */
  getToolClassInfo(): Array<{ className: string; methods: string[] }> {
    const toolInstances = this.getToolInstances();

    return toolInstances.map(({ instance, className }) => ({
      className,
      methods: instance.getHandledToolNames ? instance.getHandledToolNames() : []
    }));
  }

  /**
   * Get all tool instances via reflection.
   *
   * Scans all properties of the agent instance to find objects that
   * implement the tool interface (have getHandledToolNames method).
   *
   * @returns Array of tool instances with their class names
   * @private
   */
  private getToolInstances(): Array<{ instance: any; className: string }> {
    const instances: Array<{ instance: any; className: string }> = [];

    // Use reflection to find all tool instance properties
    const propertyNames = Object.getOwnPropertyNames(this);

    for (const propName of propertyNames) {
      const propValue = (this as any)[propName];

      // Check if this property is a tool instance (has getHandledToolNames method)
      if (propValue &&
          typeof propValue === 'object' &&
          typeof propValue.getHandledToolNames === 'function') {

        instances.push({
          instance: propValue,
          className: propValue.constructor.name
        });
      }
    }

    return instances;
  }
}
