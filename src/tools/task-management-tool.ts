import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { ChatHistoryManager } from "../utils/chat-history-manager.js";
import { ToolResult } from "../types/index.js";
import { ToolDiscovery } from "./tool-discovery.js";

/**
 * Thrown by finishTaskAndQuit / escalateAndQuit / refuseAndQuit instead of calling
 * process.exit() directly, so processPromptHeadless can flush text responses first.
 */
export class TaskQuitSignal {
  /** Entries accumulated in processUserMessage before the signal was thrown. Set by llm-agent. */
  public accumulatedEntries: any[] = [];

  constructor(
    public readonly exitCode: number,
    public readonly yamlOutput: string
  ) {}
}

export class TaskManagementTool implements ToolDiscovery {
  private agent: any = null;
  private artifactFilePath: string = path.join(
    os.homedir(), "tmp", `verification-artifact-${process.pid}-${Date.now()}.json`
  );
  private artifactMd5: string | null = null;

  setAgent(agent: any) {
    this.agent = agent;
  }

  getHandledToolNames(): string[] {
    return ["createVerificationArtifact", "finishTaskAndQuit", "escalateAndQuit", "refuseAndQuit"];
  }

  async createVerificationArtifact(
    status: string,
    task: Record<string, unknown>,
    artifact: Record<string, unknown>,
    checks: Record<string, boolean>,
    issues: string[],
    meta?: Record<string, unknown>
  ): Promise<ToolResult> {
    try {
      if (status !== "VERIFIED" && status !== "FAILED") {
        return { success: false, error: `status must be "VERIFIED" or "FAILED", got "${status}"` };
      }

      const requiredTaskFields = ["task_complete", "success_criteria_met", "external_verification_ready"];
      for (const field of requiredTaskFields) {
        if (typeof task[field] !== "boolean") {
          return { success: false, error: `task.${field} must be a boolean` };
        }
      }

      if (!checks || Object.keys(checks).length === 0) {
        return { success: false, error: "checks must have at least one entry" };
      }
      for (const [key, val] of Object.entries(checks)) {
        if (typeof val !== "boolean") {
          return { success: false, error: `checks.${key} must be a boolean` };
        }
      }

      if (!Array.isArray(issues)) {
        return { success: false, error: "issues must be an array of strings" };
      }

      const doc: Record<string, unknown> = { status, task, artifact, checks, issues };
      if (meta !== undefined) {
        doc.meta = meta;
      }

      fs.mkdirSync(path.dirname(this.artifactFilePath), { recursive: true });
      const content = JSON.stringify(doc, null, 2);
      fs.writeFileSync(this.artifactFilePath, content, "utf8");
      this.artifactMd5 = crypto.createHash("md5").update(content).digest("hex");

      return {
        success: true,
        output: `Verification artifact saved (status: ${status})`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error creating verification artifact",
      };
    }
  }

  async finishTaskAndQuit(reasoning: string, details?: string): Promise<ToolResult> {
    const artifactError = this.verifyArtifact();
    if (artifactError) {
      return { success: false, error: artifactError };
    }
    this.printYamlAndExit("finished", reasoning, 0, details);
    return { success: true, output: "" };
  }

  async escalateAndQuit(reasoning: string, details: string): Promise<ToolResult> {
    const artifactError = this.verifyArtifact();
    if (artifactError) {
      return { success: false, error: artifactError };
    }
    this.printYamlAndExit("escalated", reasoning, 1, details);
    return { success: true, output: "" };
  }

  async refuseAndQuit(reasoning: string, details: string): Promise<ToolResult> {
    this.printYamlAndExit("refused", reasoning, 2, details);
    return { success: true, output: "" };
  }

  private saveContext(): void {
    if (!this.agent) return;
    try {
      const historyManager = ChatHistoryManager.getInstance();
      historyManager.saveContext(
        this.agent.getSystemPrompt(),
        this.agent.getChatHistory(),
        this.agent.getSessionState()
      );
      historyManager.saveMessages(this.agent.getMessages());
    } catch {
      // best-effort save before exit
    }
  }

  private verifyArtifact(): string | null {
    if (!this.artifactMd5) {
      return "Verification Artifact is required but missing.  Please run createVerificationArtifact first.";
    }
    try {
      const content = fs.readFileSync(this.artifactFilePath, "utf8");
      const md5 = crypto.createHash("md5").update(content).digest("hex");
      if (md5 !== this.artifactMd5) {
        return "Verification Artifact has been altered and cannot be trusted.";
      }
    } catch {
      return "Verification Artifact file is missing or unreadable.  Please run createVerificationArtifact first.";
    }
    return null;
  }

  private yamlValue(value: string): string {
    if (value.includes("\n")) {
      return "|\n  " + value.replace(/\n/g, "\n  ");
    }
    if (/[:#\[\]{}&*!|>'"@`,]/.test(value) || value.trim() !== value) {
      return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return value;
  }

  private printYamlAndExit(
    status: "finished" | "refused" | "escalated",
    reasoning: string,
    exitCode: number,
    details?: string
  ): never {
    const lines: string[] = [
      `status: ${status}`,
      `reasoning: ${this.yamlValue(reasoning)}`,
    ];
    if (details !== undefined) {
      lines.push(`details: ${this.yamlValue(details)}`);
    }
    if (this.artifactMd5) {
      lines.push(`verification_artifact: ${this.artifactFilePath}`);
    }
    this.saveContext();
    throw new TaskQuitSignal(exitCode, lines.join("\n") + "\n");
  }
}
