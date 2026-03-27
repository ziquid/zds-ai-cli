import { LLMClient } from "../grok/client.js";
import { GrokResponsesClient, shouldUseResponsesAPI } from "../grok/responses-client.js";
import { TokenCounter, createTokenCounter } from "../utils/token-counter.js";
import { loadMCPConfig } from "../mcp/config.js";
import { initializeMCPServers } from "../grok/tools.js";
import { HookManager } from "./hook-manager.js";
import { SessionState } from "../utils/chat-history-manager.js";
import { getSettingsManager } from "../utils/settings-manager.js";

/**
 * Dependencies required by SessionManager for managing session state
 */
export interface SessionManagerDependencies {
  /** Get LLM client instance */
  getLLMClient(): LLMClient | GrokResponsesClient;
  /** Get token counter instance */
  getTokenCounter(): TokenCounter;
  /** Get API key environment variable name */
  getApiKeyEnvVar(): string;
  /** Hook manager for persona/mood/task hooks */
  hookManager: HookManager;
  /** Get current persona */
  getPersona(): string;
  /** Get persona display color */
  getPersonaColor(): string;
  /** Get current mood */
  getMood(): string;
  /** Get mood display color */
  getMoodColor(): string;
  /** Get active task name */
  getActiveTask(): string;
  /** Get active task action */
  getActiveTaskAction(): string;
  /** Get active task display color */
  getActiveTaskColor(): string;
  /** Get current model name */
  getCurrentModel(): string;
  /** Emit events */
  emit(event: string, data: any): void;
  /** Set LLM client */
  setLLMClient(client: LLMClient | GrokResponsesClient): void;
  /** Set token counter */
  setTokenCounter(counter: TokenCounter): void;
  /** Set API key environment variable */
  setApiKeyEnvVar(value: string): void;
  /** Set persona values */
  setPersona(persona: string, color: string): void;
  /** Set mood values */
  setMood(mood: string, color: string): void;
  /** Set active task values */
  setActiveTask(task: string, action: string, color: string): void;
}

/**
 * Manages session state persistence and restoration
 * 
 * Handles:
 * - Session state serialization for persistence
 * - Backend/model/API configuration restoration
 * - Persona/mood/task state restoration with hooks
 * - Working directory restoration
 * - MCP server reinitialization
 */
export class SessionManager {
  constructor(private deps: SessionManagerDependencies) {}

  /**
   * Get current session state for persistence
   * Captures all session-specific configuration and state
   * 
   * @returns SessionState object with current values
   */
  getSessionState(): SessionState {
    return {
      session: process.env.ZDS_AI_AGENT_SESSION || "",
      persona: this.deps.getPersona(),
      personaColor: this.deps.getPersonaColor(),
      mood: this.deps.getMood(),
      moodColor: this.deps.getMoodColor(),
      activeTask: this.deps.getActiveTask(),
      activeTaskAction: this.deps.getActiveTaskAction(),
      activeTaskColor: this.deps.getActiveTaskColor(),
      cwd: process.cwd(),
      contextCurrent: 0, // Will be set by caller
      contextMax: 0, // Will be set by caller
      backend: this.deps.getLLMClient().getBackendName(),
      baseUrl: this.deps.getLLMClient().getBaseURL(),
      apiKeyEnvVar: this.deps.getApiKeyEnvVar(),
      model: this.deps.getCurrentModel(),
      supportsVision: this.deps.getLLMClient().getSupportsVision(),
    };
  }

  /**
   * Restore session state from persistence
   * Restores backend configuration, working directory, and agent state
   * 
   * @param state Previously saved session state
   */
  async restoreSessionState(state: SessionState): Promise<void> {
    // Restore session ID
    if (state.session) {
      process.env.ZDS_AI_AGENT_SESSION = state.session;
    }

    // Restore cwd early (hooks may need correct working directory)
    if (state.cwd) {
      try {
        const fs = await import('fs');
        // Only attempt to change directory if it exists
        if (fs.existsSync(state.cwd)) {
          process.chdir(state.cwd);
        }
        // Silently skip if directory doesn't exist (common in containerized environments)
      } catch (error) {
        // Silently skip on any error - working directory restoration is non-critical
      }
    }

    // Restore backend/baseUrl/apiKeyEnvVar/model if present (creates initial client)
    if (state.backend && state.baseUrl && state.apiKeyEnvVar) {
      try {
        // Get API key from environment
        const apiKey = process.env[state.apiKeyEnvVar];
        if (apiKey) {
          // Create new client with restored configuration
          const model = state.model || this.deps.getCurrentModel();
          const newClient = shouldUseResponsesAPI(state.backend)
            ? new GrokResponsesClient(apiKey, model, state.baseUrl, state.backend)
            : new LLMClient(apiKey, model, state.baseUrl, state.backend);
          this.deps.setLLMClient(newClient);
          this.deps.setApiKeyEnvVar(state.apiKeyEnvVar);

          // Restore supportsVision flag if present
          if (state.supportsVision !== undefined) {
            this.deps.getLLMClient().setSupportsVision(state.supportsVision);
          }

          // Reinitialize MCP servers when restoring session
          try {
            const config = loadMCPConfig();
            if (config.servers.length > 0) {
              await initializeMCPServers();
            }
          } catch (mcpError: any) {
            console.warn("MCP reinitialization failed:", mcpError);
          }

          // Dispose old token counter and create new one for the restored model
          this.deps.getTokenCounter().dispose();
          const newTokenCounter = createTokenCounter(model);
          this.deps.setTokenCounter(newTokenCounter);

          // Emit events for UI updates
          this.deps.emit('backendChange', { backend: state.backend });
          this.deps.emit('modelChange', { model });
        } else {
          console.warn("Failed to restore backend: API key not found in environment.");
        }
      } catch (error) {
        console.warn(`Failed to restore backend configuration:`, error);
      }
    }

    // Restore persona (hook may change backend/model and sets env vars)
    if (state.persona) {
      const settings = getSettingsManager();
      const personaHook = settings.getPersonaHook();

      if (personaHook) {
        // Persona hook is configured, call it
        try {
          const result = await this.deps.hookManager.setPersona(state.persona, state.personaColor);
          if (!result.success) {
            // If persona hook failed (e.g., backend test failed), still set the persona values
            // but don't change backend/model. This prevents losing persona state on transitory errors.
            console.warn(`Persona hook failed, setting persona without backend change: ${result.error}`);
            this.deps.setPersona(state.persona, state.personaColor);
            process.env.ZDS_AI_AGENT_PERSONA = state.persona;
          }
        } catch (error) {
          console.warn(`Failed to restore persona "${state.persona}":`, error);
          // Still set persona values even if hook crashed
          this.deps.setPersona(state.persona, state.personaColor);
          process.env.ZDS_AI_AGENT_PERSONA = state.persona;
        }
      } else {
        // No persona hook configured, just set the values directly
        this.deps.setPersona(state.persona, state.personaColor);
        process.env.ZDS_AI_AGENT_PERSONA = state.persona;
      }
    }

    // Restore mood (hook sets env vars)
    if (state.mood) {
      const settings = getSettingsManager();
      const moodHook = settings.getMoodHook();

      if (moodHook) {
        // Mood hook is configured, call it
        try {
          const result = await this.deps.hookManager.setMood(state.mood, state.moodColor);
          if (!result.success) {
            // If mood hook failed (e.g., backend test failed), still set the mood values
            // but don't change backend/model. This prevents losing mood state on transitory errors.
            console.warn(`Mood hook failed, setting mood without backend change: ${result.error}`);
            this.deps.setMood(state.mood, state.moodColor);
            process.env.ZDS_AI_AGENT_MOOD = state.mood;
          }
        } catch (error) {
          console.warn(`Failed to restore mood "${state.mood}":`, error);
          // Still set mood values even if hook crashed
          this.deps.setMood(state.mood, state.moodColor);
          process.env.ZDS_AI_AGENT_MOOD = state.mood;
        }
      } else {
        // No mood hook configured, just set the values directly
        this.deps.setMood(state.mood, state.moodColor);
        process.env.ZDS_AI_AGENT_MOOD = state.mood;
      }
    }

    // Restore active task (hook sets env vars)
    if (state.activeTask) {
      try {
        const result = await this.deps.hookManager.startActiveTask(state.activeTask, state.activeTaskAction, state.activeTaskColor);
        if (!result.success) {
          // If task hook failed (e.g., backend test failed), still set the task values
          // but don't change backend/model. This prevents losing task state on transitory errors.
          console.warn(`Task hook failed, setting active task without backend change: ${result.error}`);
          this.deps.setActiveTask(state.activeTask, state.activeTaskAction, state.activeTaskColor);
          process.env.ZDS_AI_AGENT_ACTIVE_TASK = state.activeTask;
          process.env.ZDS_AI_AGENT_ACTIVE_TASK_ACTION = state.activeTaskAction;
        }
      } catch (error) {
        console.warn(`Failed to restore active task "${state.activeTask}":`, error);
        // Still set task values even if hook crashed
        this.deps.setActiveTask(state.activeTask, state.activeTaskAction, state.activeTaskColor);
        process.env.ZDS_AI_AGENT_ACTIVE_TASK = state.activeTask;
        process.env.ZDS_AI_AGENT_ACTIVE_TASK_ACTION = state.activeTaskAction;
      }
    }
  }
}