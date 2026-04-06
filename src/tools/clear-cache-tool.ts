import { ToolResult } from "../types/index.js";
import { ToolDiscovery, getHandledToolNames } from "./tool-discovery.js";

export class ClearCacheTool implements ToolDiscovery {
  private agent: any; // Reference to the LLMAgent
  private confirmationCode: string | null = null;

  setAgent(agent: any) {
    this.agent = agent;
  }

  /**
   * Generate a random 6-letter confirmation code
   */
  private generateConfirmationCode(): string {
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    return code;
  }

  /**
   * Clear the conversation cache/context
   */
  async clearCache(confirmationCode?: string): Promise<ToolResult> {
    try {
      // If no confirmation code stored yet, this is the first call
      if (!this.confirmationCode) {
        this.confirmationCode = this.generateConfirmationCode();

        return {
          success: true,
          output: `Before clearing the cache, please ensure you have:

1. Updated any task statuses (mark todos as completed, in_progress, etc.)
2. Saved all notes and lessons learned to your notes files
3. Documented any important context for the next session

Once you have completed these steps, call clearCache again with the confirmation code: ${this.confirmationCode}

Example: clearCache("${this.confirmationCode}")`,
          displayOutput: `Cache clear initiated.  Confirmation code: ${this.confirmationCode}`
        };
      }

      // Confirmation code was provided, validate it
      if (!confirmationCode) {
        return {
          success: false,
          error: `Confirmation code required.  Please call clearCache("${this.confirmationCode}")`,
          output: `Confirmation code required.  Please call clearCache("${this.confirmationCode}")`
        };
      }

      if (confirmationCode !== this.confirmationCode) {
        return {
          success: false,
          error: `Invalid confirmation code.  Expected: ${this.confirmationCode}`,
          output: `Invalid confirmation code.  Expected: ${this.confirmationCode}`
        };
      }

      // Valid confirmation code - proceed with cache clear
      if (!this.agent) {
        return {
          success: false,
          error: "Agent not available for cache clearing",
          output: "Agent not available for cache clearing"
        };
      }

      // Call the agent's existing clearCache method
      await this.agent.clearCache();

      // Reset confirmation code for next time
      this.confirmationCode = null;

      return {
        success: true,
        output: "Cache cleared successfully.  Context has been reset and initial system messages reloaded.",
        displayOutput: "Cache cleared successfully.  Context reset."
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error during cache clear",
        output: error instanceof Error ? error.message : "Unknown error during cache clear"
      };
    }
  }

  getHandledToolNames(): string[] {
    return getHandledToolNames(this);
  }
}
