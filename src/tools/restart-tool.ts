import { ToolResult } from "../types/index.js";
import { ToolDiscovery, getHandledToolNames } from "./tool-discovery.js";

export class RestartTool implements ToolDiscovery {
  /**
   * Restart the application by exiting with code 51
   */
  async restart(): Promise<ToolResult> {
    try {
      // Exit with code 51 to signal restart
      process.exit(51);

      // This line will never be reached, but TypeScript requires a return
      return {
        success: true,
        output: "Restarting application..."
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error during restart",
        output: error instanceof Error ? error.message : "Unknown error during restart"
      };
    }
  }

  getHandledToolNames(): string[] {
    return getHandledToolNames(this);
  }
}
