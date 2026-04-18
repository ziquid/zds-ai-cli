import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { ToolResult } from "../types/index.js";
import { ToolDiscovery } from "./tool-discovery.js";

export class TaskManagementTool implements ToolDiscovery {
  private artifactFilePath: string = path.join(
    os.homedir(), "tmp", `verification-artifact-${process.pid}-${Date.now()}.json`
  );
  private artifactMd5: string | null = null;

  getHandledToolNames(): string[] {
    return ["createVerificationArtifact"];
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
}
