import { getSettingsManager } from "./settings-manager.js";
import { LLMAgent } from "../agent/llm-agent.js";
import { executeOperationHook, applyHookCommands, applyEnvVariables } from "./hook-executor.js";
import { Variable } from "../agent/prompt-variables.js";

/**
 * Execute the startup hook command if configured
 * Returns the output to be added to the system prompt
 */
export async function executeStartupHook(): Promise<string | undefined> {
  const manager = getSettingsManager();
  const startupHook = manager.getStartupHook();

  if (!startupHook) {
    return undefined;
  }

  try {
    // Execute startup hook using hook executor to properly parse ENV commands
    const hookResult = await executeOperationHook(
      startupHook,
      "startup",
      {},
      10000,  // 10 second timeout
      false   // Not mandatory
    );

    if (!hookResult.approved || !hookResult.commands || hookResult.commands.length === 0) {
      return undefined;
    }

    // Apply hook commands to extract ENV variables and output
    const results = applyHookCommands(hookResult.commands);

    // Apply ENV variables to process.env BEFORE instance hook runs
    applyEnvVariables(results.env);

    // Apply prompt variables to Variable system
    const seenVars = new Set<string>();
    for (const {name, value} of results.promptVars) {
      if (seenVars.has(name)) {
        Variable.append(name, value);
      } else {
        Variable.set(name, value);
        seenVars.add(name);
      }
    }

    // Combine tool result and system output for the system prompt
    const outputParts: string[] = [];
    if (results.toolResult) {
      outputParts.push(results.toolResult);
    }
    if (results.system) {
      outputParts.push(results.system);
    }

    return outputParts.length > 0 ? outputParts.join("\n") : undefined;
  } catch (error: any) {
    console.warn("Startup hook failed:", error.message);
    return undefined;
  }
}

/**
 * Create an LLMAgent with startup hook execution and initialization
 * @param runStartupHook - Whether to run the startup hook (default: true, set false for restored sessions)
 * @param temperature - Temperature for API requests (0.0-2.0, default: 0.7)
 * @param maxTokens - Maximum tokens for API responses (positive integer, default: undefined = API default)
 */
export async function createLLMAgent(
  apiKey: string,
  baseURL?: string,
  model?: string,
  maxToolRounds?: number,
  debugLogFile?: string,
  runStartupHook: boolean = true,
  temperature?: number,
  maxTokens?: number,
  isHeadless?: boolean
): Promise<LLMAgent> {
  const startupHookOutput = runStartupHook ? await executeStartupHook() : undefined;
  const agent = new LLMAgent(apiKey, baseURL, model, maxToolRounds, debugLogFile, startupHookOutput, temperature, maxTokens, isHeadless);
  await agent.initialize();
  return agent;
}
