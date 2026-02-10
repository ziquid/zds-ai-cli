import { EventEmitter } from "events";
import { LLMClient } from "../grok/client.js";
import { TokenCounter } from "../utils/token-counter.js";
import { getSettingsManager } from "../utils/settings-manager.js";
import { executeOperationHook, applyHookCommands } from "../utils/hook-executor.js";
import { getAllLLMTools } from "../grok/tools.js";
import { logApiError } from "../utils/error-logger.js";
import { ChatEntry } from "./llm-agent.js";
import { Variable } from "./prompt-variables.js";

/**
 * Context for tracking CALL recursion depth and duplicate prevention
 */
interface CallContext {
  /** Current recursion depth */
  depth: number;
  /** Set of already-executed call signatures (toolName + serialized arguments) */
  executedCalls: Set<string>;
}

/**
 * Dependencies required by HookManager for hook execution and state management
 */
export interface HookManagerDependencies {
  /** Get LLM client for API calls */
  getLLMClient(): LLMClient;
  /** Get token counter for model operations */
  getTokenCounter(): TokenCounter;
  /** API key environment variable name */
  apiKeyEnvVar: string;
  /** LLM messages array */
  messages: any[];
  /** Chat history for display */
  chatHistory: ChatEntry[];
  /** Temperature for API calls */
  temperature: number;
  /** Get current token count */
  getCurrentTokenCount(): number;
  /** Get maximum context size */
  getMaxContextSize(): number;
  /** Get current model name */
  getCurrentModel(): string;
  /** Emit events */
  emit(event: string, data: any): void;
  /** Set API key environment variable */
  setApiKeyEnvVar(value: string): void;
  /** Set token counter */
  setTokenCounter(counter: TokenCounter): void;
  /** Set LLM client */
  setLLMClient(client: LLMClient): void;
  /** Set persona values */
  setPersona(persona: string, color: string): void;
  /** Set mood values */
  setMood(mood: string, color: string): void;
  /** Set active task values */
  setActiveTask(task: string, action: string, color: string): void;
  /** Execute a tool by name with parameters (for CALL commands) */
  executeToolByName?(toolName: string, parameters: Record<string, any>): Promise<{ success: boolean; output?: string; error?: string; hookCommands?: any[] }>;
}

/**
 * Manages hook execution for persona, mood, and task operations
 * 
 * Handles:
 * - Persona/mood/task hook execution with approval workflows
 * - Backend and model switching with validation
 * - Hook command processing and environment variable management
 * - API testing for backend/model changes
 * - System message generation for state changes
 */
export class HookManager {
  constructor(private deps: HookManagerDependencies) {}

  /**
   * Set agent persona with optional hook execution
   * Executes persona hook if configured and processes backend/model changes
   * 
   * @param persona New persona name
   * @param color Optional display color
   * @returns Success status and error message if failed
   */
  async setPersona(persona: string, color?: string): Promise<{ success: boolean; error?: string }> {
    const settings = getSettingsManager();
    const hookPath = settings.getPersonaHook();
    const hookMandatory = settings.isPersonaHookMandatory();

    if (!hookPath && hookMandatory) {
      return { success: false, error: "Persona hook is mandatory but not configured" };
    }

    if (hookPath) {
      const hookResult = await executeOperationHook(
        hookPath,
        "setPersona",
        {
          persona_old: process.env.ZDS_AI_AGENT_PERSONA || "",
          persona_new: persona,
          persona_color: color || "white"
        },
        30000,
        hookMandatory,
        this.deps.getCurrentTokenCount(),
        this.deps.getMaxContextSize()
      );

      if (!hookResult.approved) {
        await this.processHookResult(hookResult);
        return { success: false, error: hookResult.reason || "Hook rejected persona change" };
      }

      const result = await this.processHookResult(hookResult, 'ZDS_AI_AGENT_PERSONA');
      if (!result.success) {
        return { success: false, error: "Persona change rejected due to failed model/backend test" };
      }

      if (result.transformedValue) {
        persona = result.transformedValue;
      }
    }

    process.env.ZDS_AI_AGENT_PERSONA = persona;
    this.deps.setPersona(persona, color || "white");
    this.deps.emit('personaChange', { persona, color: color || "white" });
    return { success: true };
  }

  /**
   * Set agent mood with optional hook execution
   * Executes mood hook if configured and adds system message to chat
   * 
   * @param mood New mood name
   * @param color Optional display color
   * @returns Success status and error message if failed
   */
  async setMood(mood: string, color?: string): Promise<{ success: boolean; error?: string }> {
    const settings = getSettingsManager();
    const hookPath = settings.getMoodHook();
    const hookMandatory = settings.isMoodHookMandatory();

    if (!hookPath && hookMandatory) {
      return { success: false, error: "Mood hook is mandatory but not configured" };
    }

    if (hookPath) {
      const hookResult = await executeOperationHook(
        hookPath,
        "setMood",
        {
          mood_old: process.env.ZDS_AI_AGENT_MOOD || "",
          mood_new: mood,
          mood_color: color || "white"
        },
        30000,
        hookMandatory,
        this.deps.getCurrentTokenCount(),
        this.deps.getMaxContextSize()
      );

      if (!hookResult.approved) {
        await this.processHookResult(hookResult);
        return { success: false, error: hookResult.reason || "Hook rejected mood change" };
      }

      const result = await this.processHookResult(hookResult, 'ZDS_AI_AGENT_MOOD');
      if (!result.success) {
        return { success: false, error: "Mood change rejected due to failed model/backend test" };
      }

      if (result.transformedValue) {
        mood = result.transformedValue;
      }
    }

    process.env.ZDS_AI_AGENT_MOOD = mood;
    this.deps.setMood(mood, color || "white");

    const oldMood = process.env.ZDS_AI_AGENT_MOOD_OLD || "";
    const oldColor = process.env.ZDS_AI_AGENT_MOOD_COLOR_OLD || "white";
    let systemContent: string;
    if (oldMood) {
      const oldColorStr = oldColor !== "white" ? ` (${oldColor})` : "";
      const newColorStr = color && color !== "white" ? ` (${color})` : "";
      systemContent = `Assistant changed the mood from "${oldMood}"${oldColorStr} to "${mood}"${newColorStr}`;
    } else {
      const colorStr = color && color !== "white" ? ` (${color})` : "";
      systemContent = `Assistant set the mood to "${mood}"${colorStr}`;
    }

    this.deps.chatHistory.push({
      type: 'system',
      content: systemContent,
      timestamp: new Date()
    });

    this.deps.emit('moodChange', { mood, color: color || "white" });
    return { success: true };
  }

  /**
   * Start a new active task with approval hook
   * Prevents starting if another task is already active
   * 
   * @param activeTask Task name
   * @param action Task action/status
   * @param color Optional display color
   * @returns Success status and error message if failed
   */
  async startActiveTask(activeTask: string, action: string, color?: string): Promise<{ success: boolean; error?: string }> {
    if (process.env.ZDS_AI_AGENT_ACTIVE_TASK) {
      return {
        success: false,
        error: `Cannot start new task "${activeTask}". Active task "${process.env.ZDS_AI_AGENT_ACTIVE_TASK}" must be stopped first.`
      };
    }

    const settings = getSettingsManager();
    const hookPath = settings.getTaskApprovalHook();

    if (hookPath) {
      const hookResult = await executeOperationHook(
        hookPath,
        "startActiveTask",
        { activetask: activeTask, action, color: color || "white" },
        30000,
        false,
        this.deps.getCurrentTokenCount(),
        this.deps.getMaxContextSize()
      );

      await this.processHookResult(hookResult);

      if (!hookResult.approved) {
        return { success: false, error: hookResult.reason || "Hook rejected task start" };
      }
    }

    process.env.ZDS_AI_AGENT_ACTIVE_TASK = activeTask;
    process.env.ZDS_AI_AGENT_ACTIVE_TASK_ACTION = action;
    this.deps.setActiveTask(activeTask, action, color || "white");

    const colorStr = color && color !== "white" ? ` (${color})` : "";
    this.deps.messages.push({
      role: 'system',
      content: `Assistant changed task status for "${activeTask}" to ${action}${colorStr}`
    });

    this.deps.emit('activeTaskChange', { activeTask, action, color: color || "white" });
    return { success: true };
  }

  /**
   * Transition active task status with approval hook
   * Requires an active task to be running
   * 
   * @param action New task action/status
   * @param color Optional display color
   * @returns Success status and error message if failed
   */
  async transitionActiveTaskStatus(action: string, color?: string): Promise<{ success: boolean; error?: string }> {
    if (!process.env.ZDS_AI_AGENT_ACTIVE_TASK) {
      return { success: false, error: "Cannot transition task status. No active task is currently running." };
    }

    const settings = getSettingsManager();
    const hookPath = settings.getTaskApprovalHook();

    if (hookPath) {
      const hookResult = await executeOperationHook(
        hookPath,
        "transitionActiveTaskStatus",
        { action, color: color || "white" },
        30000,
        false,
        this.deps.getCurrentTokenCount(),
        this.deps.getMaxContextSize()
      );

      await this.processHookResult(hookResult);

      if (!hookResult.approved) {
        return { success: false, error: hookResult.reason || "Hook rejected task status transition" };
      }
    }

    const oldAction = process.env.ZDS_AI_AGENT_ACTIVE_TASK_ACTION || "";
    process.env.ZDS_AI_AGENT_ACTIVE_TASK_ACTION = action;

    const colorStr = color && color !== "white" ? ` (${color})` : "";
    this.deps.messages.push({
      role: 'system',
      content: `Assistant changed task status for "${process.env.ZDS_AI_AGENT_ACTIVE_TASK}" from ${oldAction} to ${action}${colorStr}`
    });

    this.deps.emit('activeTaskChange', {
      activeTask: process.env.ZDS_AI_AGENT_ACTIVE_TASK,
      action,
      color: color || "white"
    });
    return { success: true };
  }

  /**
   * Stop active task with approval hook and minimum delay
   * Enforces 3-second minimum delay for task completion
   * 
   * @param reason Reason for stopping task
   * @param documentationFile Documentation file path
   * @param color Optional display color
   * @returns Success status and error message if failed
   */
  async stopActiveTask(reason: string, documentationFile: string, color?: string): Promise<{ success: boolean; error?: string }> {
    if (!process.env.ZDS_AI_AGENT_ACTIVE_TASK) {
      return { success: false, error: "Cannot stop task. No active task is currently running." };
    }

    const startTime = Date.now();
    const settings = getSettingsManager();
    const hookPath = settings.getTaskApprovalHook();

    if (hookPath) {
      const hookResult = await executeOperationHook(
        hookPath,
        "stopActiveTask",
        { reason, documentation_file: documentationFile, color: color || "white" },
        30000,
        false,
        this.deps.getCurrentTokenCount(),
        this.deps.getMaxContextSize()
      );

      await this.processHookResult(hookResult);

      if (!hookResult.approved) {
        return { success: false, error: hookResult.reason || "Hook rejected task stop" };
      }
    }

    const elapsed = Date.now() - startTime;
    const remainingDelay = Math.max(0, 3000 - elapsed);
    if (remainingDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, remainingDelay));
    }

    const stoppedTask = process.env.ZDS_AI_AGENT_ACTIVE_TASK;
    const stoppedAction = process.env.ZDS_AI_AGENT_ACTIVE_TASK_ACTION || "";

    delete process.env.ZDS_AI_AGENT_ACTIVE_TASK;
    delete process.env.ZDS_AI_AGENT_ACTIVE_TASK_ACTION;

    const colorStr = color && color !== "white" ? ` (${color})` : "";
    this.deps.messages.push({
      role: 'system',
      content: `Assistant stopped task "${stoppedTask}" (was ${stoppedAction}) with reason: ${reason}${colorStr}`
    });

    this.deps.emit('activeTaskChange', { activeTask: "", action: "", color: "white" });
    return { success: true };
  }

  /**
   * Process hook result commands and apply environment changes
   * Handles backend/model changes, environment variables, and system messages
   * 
   * @param hookResult Hook execution result with commands
   * @param envKey Optional environment key to extract transformed value
   * @returns Success status and transformed value if applicable
   */
  async processHookResult(
    hookResult: { commands?: any[] },
    envKey?: string
  ): Promise<{ success: boolean; transformedValue?: string }> {
    if (!hookResult.commands) {
      return { success: true };
    }

    const results = applyHookCommands(hookResult.commands);
    let transformedValue: string | undefined;
    if (envKey && results.env[envKey]) {
      transformedValue = results.env[envKey];
    }

    const success = await this.processHookCommands(results);
    return { success, transformedValue };
  }

  /**
   * Process hook commands with backend/model testing
   * Tests API connectivity before applying changes
   * 
   * @param commands Processed hook commands
   * @returns Success status of command processing
   */
  private async processHookCommands(commands: ReturnType<typeof applyHookCommands>): Promise<boolean> {
    const { applyEnvVariables } = await import('../utils/hook-executor.js');
    const hasBackendChange = commands.backend && commands.baseUrl && commands.apiKeyEnvVar;
    const hasModelChange = commands.model && commands.model !== this.deps.getCurrentModel();

    // Apply immediate (non-conditional) commands right away
    applyEnvVariables(commands.env);
    const seenVars = new Set<string>();
    for (const {name, value} of commands.promptVars) {
      if (seenVars.has(name)) {
        Variable.append(name, value);
      } else {
        Variable.set(name, value);
        seenVars.add(name);
      }
    }
    if (commands.system) {
      this.deps.chatHistory.push({
        type: "system",
        content: commands.system,
        timestamp: new Date(),
      });
    }

    // Check for CONDITIONAL commands without any CONDITION - this is an error
    if (commands.conditionalResults && !hasBackendChange && !hasModelChange) {
      const errorMsg = "Hook error: CONDITIONAL commands present but no CONDITION BACKEND or CONDITION MODEL specified. Conditional commands ignored.";
      console.warn(errorMsg);
      this.deps.chatHistory.push({
        type: "system",
        content: errorMsg,
        timestamp: new Date(),
      });
      // Don't return false - allow processing to continue, just skip the conditional commands
    }

    // If there's a backend/model change, test it and apply conditional commands on success
    if (hasBackendChange) {
      const testResult = await this.testBackendModelChange(
        commands.backend!,
        commands.baseUrl!,
        commands.apiKeyEnvVar!,
        commands.model
      );

      if (!testResult.success) {
        const parts = [];
        if (commands.backend) parts.push(`backend to "${commands.backend}"`);
        if (commands.model) parts.push(`model to "${commands.model}"`);
        const errorMsg = `Failed to change ${parts.join(' and ')}: ${testResult.error}`;
        this.deps.chatHistory.push({
          type: "system",
          content: errorMsg,
          timestamp: new Date(),
        });
        return false;
      }

      // Apply conditional commands after successful test
      if (commands.conditionalResults) {
        applyEnvVariables(commands.conditionalResults.env);
        const seenVars = new Set<string>();
        for (const {name, value} of commands.conditionalResults.promptVars) {
          if (seenVars.has(name)) {
            Variable.append(name, value);
          } else {
            Variable.set(name, value);
            seenVars.add(name);
          }
        }
        if (commands.conditionalResults.system) {
          this.deps.chatHistory.push({
            type: "system",
            content: commands.conditionalResults.system,
            timestamp: new Date(),
          });
        }
      }

      const parts = [];
      if (commands.backend) parts.push(`backend to "${commands.backend}"`);
      if (commands.model) parts.push(`model to "${commands.model}"`);
      const successMsg = `Changed ${parts.join(' and ')}`;
      this.deps.chatHistory.push({
        type: "system",
        content: successMsg,
        timestamp: new Date(),
      });

      if (commands.backend) {
        this.deps.emit('backendChange', { backend: commands.backend });
      }
      if (commands.model) {
        this.deps.emit('modelChange', { model: commands.model });
      }
    } else if (hasModelChange) {
      const testResult = await this.testModel(commands.model!);
      if (!testResult.success) {
        const errorMsg = `Failed to change model to "${commands.model}": ${testResult.error}`;
        this.deps.chatHistory.push({
          type: "system",
          content: errorMsg,
          timestamp: new Date(),
        });
        return false;
      }

      // Apply conditional commands after successful test
      if (commands.conditionalResults) {
        applyEnvVariables(commands.conditionalResults.env);
        const seenVars = new Set<string>();
        for (const {name, value} of commands.conditionalResults.promptVars) {
          if (seenVars.has(name)) {
            Variable.append(name, value);
          } else {
            Variable.set(name, value);
            seenVars.add(name);
          }
        }
        if (commands.conditionalResults.system) {
          this.deps.chatHistory.push({
            type: "system",
            content: commands.conditionalResults.system,
            timestamp: new Date(),
          });
        }
      }

      const successMsg = `Model changed to "${commands.model}"`;
      this.deps.chatHistory.push({
        type: "system",
        content: successMsg,
        timestamp: new Date(),
      });

      this.deps.emit('modelChange', { model: commands.model });
    }
    // If no backend/model change, conditional commands are ignored (there's no condition to satisfy)

    // Execute CALL commands after all other processing (fire-and-forget)
    // Execute immediate CALLs
    if (commands.calls.length > 0) {
      this.executeCalls(commands.calls).catch(error => {
        console.error("Error executing immediate CALL commands:", error);
      });
    }

    // Execute conditional CALLs only if backend/model test succeeded
    if (commands.conditionalResults && commands.conditionalResults.calls.length > 0 && (hasBackendChange || hasModelChange)) {
      this.executeCalls(commands.conditionalResults.calls).catch(error => {
        console.error("Error executing conditional CALL commands:", error);
      });
    }

    return true;
  }

  /**
   * Render system message with current variable state
   * Updates messages[0] with fresh system prompt from variables
   */
  private renderSystemMessage(): void {
    this.deps.messages[0] = {
      role: "system",
      content: Variable.renderFull('SYSTEM')
    };
  }

  /**
   * Test model change by making API call
   * Validates model compatibility before switching
   *
   * @param newModel Model name to test
   * @returns Success status and error message if failed
   */
  private async testModel(newModel: string): Promise<{ success: boolean; error?: string }> {
    const previousModel = this.deps.getCurrentModel();
    const previousTokenCounter = this.deps.getTokenCounter();

    // Render system message with current variable state before testing
    this.renderSystemMessage();
    const testMessages = this.stripInProgressToolCalls(this.deps.messages);
    const supportsTools = this.deps.getLLMClient().getSupportsTools();
    const tools = supportsTools ? await getAllLLMTools() : [];
    const requestPayload = {
      model: newModel,
      messages: testMessages,
      tools: supportsTools && tools.length > 0 ? tools : undefined,
      temperature: this.deps.temperature,
      max_tokens: 500
    };

    try {
      await this.deps.getLLMClient().setModel(newModel);
      const { createTokenCounter } = await import("../utils/token-counter.js");
      this.deps.setTokenCounter(createTokenCounter(newModel));

      const response = await this.deps.getLLMClient().chat(
        testMessages,
        tools,
        newModel,
        undefined,
        this.deps.temperature,
        undefined,
        500
      );

      if (!response || !response.choices || response.choices.length === 0) {
        throw new Error("Invalid response from API");
      }

      previousTokenCounter.dispose();
      return { success: true };

    } catch (error: any) {
      this.deps.getLLMClient().setModel(previousModel);
      this.deps.getTokenCounter().dispose();
      this.deps.setTokenCounter(previousTokenCounter);

      const { message: logPaths } = await logApiError(
        requestPayload,
        error,
        { errorType: 'model-switch-test-failure', previousModel, newModel },
        'test-fail'
      );

      const errorMessage = error.message || "Unknown error during model test";
      return {
        success: false,
        error: `Model test failed: ${errorMessage}\n${logPaths}`
      };
    }
  }

  /**
   * Test backend and model change by making API call
   * Validates backend connectivity and model compatibility
   * 
   * @param backend Backend name
   * @param baseUrl API base URL
   * @param apiKeyEnvVar Environment variable for API key
   * @param model Optional model name
   * @returns Success status and error message if failed
   */
  private async testBackendModelChange(
    backend: string,
    baseUrl: string,
    apiKeyEnvVar: string,
    model?: string
  ): Promise<{ success: boolean; error?: string }> {
    const previousClient = this.deps.getLLMClient();
    const previousTokenCounter = this.deps.getTokenCounter();
    const previousApiKeyEnvVar = this.deps.apiKeyEnvVar;
    const previousBackend = this.deps.getLLMClient().getBackendName();
    const previousModel = this.deps.getCurrentModel();

    let requestPayload: any;
    let newModel: string;
    let modelChanged = false;

    try {
      const apiKey = process.env[apiKeyEnvVar];
      if (!apiKey) {
        throw new Error(`API key not found in environment variable: ${apiKeyEnvVar}`);
      }

      newModel = model || this.deps.getCurrentModel();
      modelChanged = newModel !== previousModel;
      const newClient = new LLMClient(apiKey, newModel, baseUrl, backend);
      this.deps.setLLMClient(newClient);
      this.deps.setApiKeyEnvVar(apiKeyEnvVar);

      // Update token counter only if model changed
      if (modelChanged) {
        const { createTokenCounter } = await import("../utils/token-counter.js");
        this.deps.setTokenCounter(createTokenCounter(newModel));
      }

      const { loadMCPConfig } = await import("../mcp/config.js");
      const { initializeMCPServers } = await import("../grok/tools.js");
      try {
        const config = loadMCPConfig();
        if (config.servers.length > 0) {
          await initializeMCPServers();
        }
      } catch (mcpError: any) {
        console.warn("MCP reinitialization failed:", mcpError);
      }

      // Render system message with current variable state before testing
      this.renderSystemMessage();
      const testMessages = this.stripInProgressToolCalls(this.deps.messages);
      const supportsTools = this.deps.getLLMClient().getSupportsTools();
      const tools = supportsTools ? await getAllLLMTools() : [];
      requestPayload = {
        backend,
        baseUrl,
        model: newModel,
        messages: testMessages,
        tools: supportsTools && tools.length > 0 ? tools : undefined,
        temperature: this.deps.temperature,
        max_tokens: 500
      };

      const response = await this.deps.getLLMClient().chat(
        testMessages,
        tools,
        newModel,
        undefined,
        this.deps.temperature,
        undefined,
        500
      );

      if (!response || !response.choices || response.choices.length === 0) {
        throw new Error("Invalid response from API");
      }

      // Dispose old token counter if model changed
      if (modelChanged) {
        previousTokenCounter.dispose();
      }

      return { success: true };

    } catch (error: any) {
      this.deps.setLLMClient(previousClient);
      this.deps.setApiKeyEnvVar(previousApiKeyEnvVar);

      // Restore token counter if we changed it
      if (modelChanged) {
        this.deps.getTokenCounter().dispose();
        this.deps.setTokenCounter(previousTokenCounter);
      }

      let logPaths = '';
      if (requestPayload) {
        const result = await logApiError(
          requestPayload,
          error,
          {
            errorType: 'backend-switch-test-failure',
            previousBackend,
            previousModel,
            newBackend: backend,
            newModel,
            baseUrl,
            apiKeyEnvVar
          },
          'test-fail'
        );
        logPaths = result.message;
      }

      const errorMessage = error.message || "Unknown error during backend/model test";
      return {
        success: false,
        error: logPaths ? `${errorMessage}\n${logPaths}` : errorMessage
      };
    }
  }

  /**
   * Strip in-progress tool calls from messages for API testing
   * Removes incomplete tool call sequences to avoid API errors
   * 
   * @param messages Message array to clean
   * @returns Cleaned message array without incomplete tool calls
   */
  private stripInProgressToolCalls(messages: any[]): any[] {
    let lastAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        lastAssistantIndex = i;
        break;
      }
    }

    if (lastAssistantIndex === -1 || !(messages[lastAssistantIndex] as any).tool_calls) {
      return messages;
    }

    const cleanedMessages = JSON.parse(JSON.stringify(messages));
    const toolCallIds = new Set(
      ((cleanedMessages[lastAssistantIndex] as any).tool_calls || []).map((tc: any) => tc.id)
    );

    delete (cleanedMessages[lastAssistantIndex] as any).tool_calls;

    return cleanedMessages.filter((msg, idx) => {
      if (idx <= lastAssistantIndex) {
        return true;
      }
      if (msg.role === 'tool' && toolCallIds.has((msg as any).tool_call_id)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Execute CALL commands asynchronously with recursion depth and duplicate tracking
   * Fire-and-forget execution that processes hooks from called tools
   *
   * @param calls Array of CALL command strings
   * @param context Call context for tracking recursion and duplicates
   */
  private async executeCalls(calls: string[], context: CallContext = { depth: 0, executedCalls: new Set() }): Promise<void> {
    // Maximum recursion depth is 5
    const MAX_DEPTH = 5;

    if (context.depth >= MAX_DEPTH) {
      console.warn(`CALL recursion depth limit (${MAX_DEPTH}) reached, skipping remaining calls`);
      return;
    }

    // Check if executeToolByName is available
    if (!this.deps.executeToolByName) {
      console.warn("CALL commands require executeToolByName dependency, skipping calls");
      return;
    }

    for (const callSpec of calls) {
      // Parse "toolName arg1=val1 arg2=val2"
      const parts = callSpec.trim().split(/\s+/);
      if (parts.length === 0) {
        continue;
      }

      const toolName = parts[0];
      const parameters: Record<string, any> = {};

      // Parse parameters
      for (let i = 1; i < parts.length; i++) {
        const match = parts[i].match(/^([^=]+)=(.*)$/);
        if (match) {
          const [, key, value] = match;
          // Try to parse as JSON, fall back to string
          try {
            parameters[key] = JSON.parse(value);
          } catch {
            parameters[key] = value;
          }
        }
      }

      // Create signature for duplicate detection
      const signature = `${toolName}:${JSON.stringify(parameters)}`;
      if (context.executedCalls.has(signature)) {
        console.warn(`Skipping duplicate CALL: ${signature}`);
        continue;
      }

      // Mark as executed
      context.executedCalls.add(signature);

      // Execute tool asynchronously (fire-and-forget)
      this.executeCallAsync(toolName, parameters, context).catch(error => {
        console.error(`Error executing CALL ${toolName}:`, error);
      });
    }
  }

  /**
   * Execute a single CALL asynchronously with hook processing
   * Runs tool hooks which may generate more CALL commands
   *
   * @param toolName Tool to execute
   * @param parameters Tool parameters
   * @param context Call context for tracking recursion
   */
  private async executeCallAsync(
    toolName: string,
    parameters: Record<string, any>,
    context: CallContext
  ): Promise<void> {
    if (!this.deps.executeToolByName) {
      return;
    }

    try {
      // Execute the tool
      const result = await this.deps.executeToolByName(toolName, parameters);

      // Process any hook commands that were generated during tool execution
      if (result.hookCommands && result.hookCommands.length > 0) {
        const hookResults = applyHookCommands(result.hookCommands);

        // Extract CALL commands from hook results (both immediate and conditional)
        const recursiveCalls: string[] = [...hookResults.calls];

        // Add conditional calls if present (they would have been validated by the tool's hooks)
        if (hookResults.conditionalResults && hookResults.conditionalResults.calls.length > 0) {
          recursiveCalls.push(...hookResults.conditionalResults.calls);
        }

        // Recursively execute CALL commands with incremented depth
        if (recursiveCalls.length > 0) {
          const nestedContext: CallContext = {
            depth: context.depth + 1,
            executedCalls: context.executedCalls, // Share the same set to prevent duplicates across entire chain
          };
          await this.executeCalls(recursiveCalls, nestedContext);
        }
      }

    } catch (error) {
      console.error(`Error in executeCallAsync for ${toolName}:`, error);
    }
  }
}