import { LLMToolCall } from "../grok/client.js";
import { ToolResult } from "../types/index.js";
import { getAllLLMTools, getMCPManager } from "../grok/tools.js";
import { executeToolApprovalHook, executePreToolCallHook, executePostToolCallHook } from "../utils/hook-executor.js";
import { getSettingsManager } from "../utils/settings-manager.js";
import { execSync } from "child_process";

/** Maximum attempts to parse nested JSON strings */
const MAX_JSON_PARSE_ATTEMPTS = 5;

/**
 * Extract first complete JSON object from concatenated JSON strings
 * Handles LLM bug where multiple JSON objects are concatenated: {"a":1}{"b":2}
 * 
 * @param jsonString String potentially containing concatenated JSON
 * @returns First valid JSON object or original string if no duplicates
 */
function extractFirstJsonObject(jsonString: string): string {
  if (!jsonString.includes('}{')) return jsonString;
  try {
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
      const firstObj = jsonString.substring(0, firstObjEnd);
      JSON.parse(firstObj);
      return firstObj;
    }
  } catch {
    // If extraction fails, return the original string
  }
  return jsonString;
}

/**
 * Executes tool calls from LLM with validation, approval hooks, and error handling
 * 
 * Handles:
 * - Tool argument parsing and validation
 * - JSON encoding bug fixes (nested strings, concatenated objects)
 * - Tool approval hooks for security
 * - Parameter defaults and validation
 * - Built-in and MCP tool execution
 */
export class ToolExecutor {
  constructor(
    /** Main LLM agent instance */
    private agent: any,
    /** Text editor tool for file operations */
    private textEditor: any,
    /** Morph editor for fast code editing */
    private morphEditor: any,
    /** Shell execution tool */
    private zsh: any,
    /** Search tool for code/file searching */
    private search: any,
    /** Environment variable tool */
    private env: any,
    /** Introspection tool for system info */
    private introspect: any,
    /** Cache clearing tool */
    private clearCacheTool: any,
    /** Restart tool */
    private restartTool: any,
    /** Character/persona management tool */
    private characterTool: any,
    /** Task management tool */
    private taskTool: any,
    /** Internet/web tool */
    private internetTool: any,
    /** Image processing tool */
    private imageTool: any,
    /** File conversion tool */
    private fileConversionTool: any,
    /** Audio processing tool */
    private audioTool: any,
    /** Task management tool (verification artifacts, etc.) */
    private taskManagementTool: any
  ) {}

  /**
   * Apply default parameter values for specific tools
   * Ensures tools have sensible defaults when parameters are omitted
   * 
   * @param toolName Name of the tool being executed
   * @param params Tool parameters object
   * @returns Parameters with defaults applied
   */
  private applyToolParameterDefaults(toolName: string, params: any): any {
    const result = { ...(params || {}) };
    switch (toolName) {
      case "listFiles":
        if (!result.dirname) {
          result.dirname = ".";
        }
        break;
    }
    return result;
  }

  /**
   * Validate tool arguments against tool schema
   * Checks parameter names, required parameters, and parameter counts
   * 
   * @param toolName Name of the tool to validate
   * @param args Arguments to validate
   * @returns Error message if invalid, null if valid
   */
  private async validateToolArguments(toolName: string, args: any): Promise<string | null> {
    try {
      const supportsTools = this.agent.llmClient.getSupportsTools();
      const allTools = supportsTools ? await getAllLLMTools() : [];
      const toolSchema = allTools.find(t => t.function.name === toolName);
      if (!toolSchema) {
        return `Unknown tool: ${toolName}`;
      }

      const schema = toolSchema.function.parameters;
      const properties = schema.properties || {};
      const required = schema.required || [];

      const acceptsNoParams = Object.keys(properties).length === 0;
      const hasArgs = args && typeof args === 'object' && Object.keys(args).length > 0;

      if (acceptsNoParams && hasArgs) {
        return `Tool ${toolName} accepts no parameters, but received: ${JSON.stringify(args)}`;
      }

      for (const argKey of Object.keys(args || {})) {
        if (!properties[argKey]) {
          return `Tool ${toolName} does not accept parameter '${argKey}'. Valid parameters: ${Object.keys(properties).join(', ') || 'none'}`;
        }
      }

      for (const requiredParam of required) {
        if (!(requiredParam in (args || {}))) {
          return `Tool ${toolName} missing required parameter '${requiredParam}'`;
        }
      }

      return null;
    } catch (error) {
      console.error(`Error validating tool arguments for ${toolName}:`, error);
      return null;
    }
  }

  /**
   * Execute a tool call with full validation and error handling
   * Main entry point for tool execution from LLM responses
   * 
   * @param toolCall LLM tool call object with function name and arguments
   * @returns Tool execution result with success/error status
   */
  async executeTool(toolCall: LLMToolCall): Promise<ToolResult> {
    try {
      let argsString = toolCall.function.arguments?.trim() || "{}";
      let hadDuplicateJson = false;
      const extractedArgsString = extractFirstJsonObject(argsString);
      if (extractedArgsString !== argsString) {
        hadDuplicateJson = true;
        argsString = extractedArgsString;
      }

      let args = JSON.parse(argsString);
      let parseCount = 0;
      while (typeof args === 'string' && parseCount < MAX_JSON_PARSE_ATTEMPTS) {
        parseCount++;
        try {
          args = JSON.parse(args);
        } catch (e) {
          break;
        }
      }

      if (parseCount > 0) {
        const bugMsg = `[BUG] Tool ${toolCall.function.name} had ${parseCount} extra layer(s) of JSON encoding`;
        console.warn(bugMsg);
        const systemMsg = `Warning: Tool arguments for ${toolCall.function.name} had ${parseCount} extra encoding layer(s) - this is an API bug`;
        this.agent.messages.push({ role: 'system', content: systemMsg });
        this.agent.chatHistory.push({ type: 'system', content: systemMsg, timestamp: new Date() });
      }

      if (hadDuplicateJson) {
        const bugMsg = `[BUG] Tool ${toolCall.function.name} had duplicate/concatenated JSON objects`;
        console.warn(bugMsg);
        const systemMsg = `Warning: Tool arguments for ${toolCall.function.name} had duplicate JSON objects (used first object only) - this is an LLM bug`;
        this.agent.messages.push({ role: 'system', content: systemMsg });
        this.agent.chatHistory.push({ type: 'system', content: systemMsg, timestamp: new Date() });
      }

      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        args = {};
      }

      args = this.applyToolParameterDefaults(toolCall.function.name, args);

      const validationError = await this.validateToolArguments(toolCall.function.name, args);
      if (validationError) {
        console.warn(`[VALIDATION ERROR] ${validationError}`);
        return { success: false, error: validationError };
      }

      // Extract rationale before passing to the tool — the tool doesn't need it,
      // but it is forwarded to hooks (via PARAM env vars) and saved in context.json.
      const rationale: string = typeof args.rationale === 'string' ? args.rationale : '';
      const argsForTool = { ...args };
      delete argsForTool.rationale;

      const isTaskTool = ['startActiveTask', 'transitionActiveTaskStatus', 'stopActiveTask'].includes(toolCall.function.name);
      const settings = getSettingsManager();
      const toolApprovalHook = settings.getToolApprovalHook();

      if (toolApprovalHook && !isTaskTool) {
        const approvalResult = await executeToolApprovalHook(
          toolApprovalHook,
          toolCall.function.name,
          args,  // pass args WITH rationale so hooks get PARAM_RATIONALE
          30000,
          this.agent.getCurrentTokenCount(),
          this.agent.getMaxContextSize()
        );

        if (!approvalResult.approved) {
          const reason = approvalResult.reason || "Tool execution denied by approval hook";
          await this.agent.processHookResult(approvalResult);
          return { success: false, error: `Tool execution blocked: ${reason}` };
        }

        if (approvalResult.timedOut) {
          console.warn(`Tool approval hook timed out for ${toolCall.function.name} (auto-approved)`);
        }

        await this.agent.processHookResult(approvalResult);
      }

      // Execute preToolCall hook (pass args WITH rationale so PARAM_RATIONALE is set)
      const preToolCallHookPath = settings.getPreToolCallHook();
      if (preToolCallHookPath && !isTaskTool) {
        const hookResult = await executePreToolCallHook(
          preToolCallHookPath,
          toolCall.function.name,
          args,
          30000,
          this.agent.getCurrentTokenCount(),
          this.agent.getMaxContextSize()
        );

        // Process hook results (env vars, system messages, etc.)
        await this.agent.processHookResult(hookResult);
      }

      const result = await this.executeToolByName(toolCall.function.name, argsForTool);
      result.rationale = rationale;

      // Execute postToolCall hook (pass args WITH rationale so PARAM_RATIONALE is set)
      const postToolCallHookPath = settings.getPostToolCallHook();
      if (postToolCallHookPath && !isTaskTool) {
        const hookResult = await executePostToolCallHook(
          postToolCallHookPath,
          toolCall.function.name,
          args,
          result,
          30000,
          this.agent.getCurrentTokenCount(),
          this.agent.getMaxContextSize()
        );

        // Process hook results (env vars, system messages, etc.)
        await this.agent.processHookResult(hookResult);
      }

      return result;
    } catch (error: any) {
      return { success: false, error: `Tool execution error: ${error.message}` };
    }
  }

  /**
   * Execute tool by name with parsed arguments
   * Routes to appropriate tool implementation based on tool name
   * 
   * @param toolName Name of tool to execute
   * @param args Parsed and validated arguments
   * @returns Tool execution result
   */
  private async executeToolByName(toolName: string, args: any): Promise<ToolResult> {
    switch (toolName) {
      case "viewFile":
        const range = args.start_line && args.end_line ? [args.start_line, args.end_line] : undefined;
        return await this.textEditor.viewFile(args.filename, range);
      case "createNewFile":
        return await this.textEditor.createNewFile(args.filename, args.content);
      case "strReplace":
        return await this.textEditor.strReplace(args.filename, args.old_str, args.new_str, args.replace_all);
      case "editFile":
        if (!this.morphEditor) {
          return { success: false, error: "Morph Fast Apply not available. Please set MORPH_API_KEY environment variable to use this feature." };
        }
        return await this.morphEditor.editFile(args.filename, args.instructions, args.code_edit);
      case "execute":
        return await this.zsh.execute(args.command);
      case "listFiles":
        return await this.zsh.listFiles(args.dirname);
      case "universalSearch":
        return await this.search.universalSearch(args.query, {
          searchType: args.search_type,
          includePattern: args.include_pattern,
          excludePattern: args.exclude_pattern,
          caseSensitive: args.case_sensitive,
          wholeWord: args.whole_word,
          regex: args.regex,
          maxResults: args.max_results,
          fileTypes: args.file_types,
          includeHidden: args.include_hidden,
        });
      case "getEnv":
        return await this.env.getEnv(args.variable);
      case "getAllEnv":
        return await this.env.getAllEnv();
      case "searchEnv":
        return await this.env.searchEnv(args.pattern);
      case "introspect":
        return await this.introspect.introspect(args.target);
      case "clearCache":
        return await this.clearCacheTool.clearCache(args.confirmationCode);
      case "restart":
        return await this.restartTool.restart();
      case "setPersona":
        return await this.characterTool.setPersona(args.persona, args.color);
      case "setMood":
        return await this.characterTool.setMood(args.mood, args.color);
      case "getPersona":
        return await this.characterTool.getPersona();
      case "getMood":
        return await this.characterTool.getMood();
      case "getAvailablePersonas":
        return await this.characterTool.getAvailablePersonas();
      case "startActiveTask":
        return await this.taskTool.startActiveTask(args.activeTask, args.action, args.color);
      case "transitionActiveTaskStatus":
        return await this.taskTool.transitionActiveTaskStatus(args.action, args.color);
      case "stopActiveTask":
        return await this.taskTool.stopActiveTask(args.reason, args.documentationFile, args.color);
      case "insertLines":
        return await this.textEditor.insertLines(args.filename, args.insert_line, args.new_str);
      case "replaceLines":
        return await this.textEditor.replaceLines(args.filename, args.start_line, args.end_line, args.new_str);
      case "undoEdit":
        return await this.textEditor.undoEdit();
      case "chdir":
        return this.zsh.chdir(args.dirname);
      case "pwdir":
        return this.zsh.pwdir();
      case "downloadFile":
        return await this.internetTool.downloadFile(args.url);
      case "generateImage":
        return await this.imageTool.generateImage(
          args.prompt, args.negativePrompt, args.width, args.height, args.model,
          args.sampler, args.configScale, args.numSteps, args.nsfw, args.name, args.move, args.seed
        );
      case "captionImage":
        return await this.imageTool.captionImage(args.filename, args.backend);
      case "compareImageToPrompt":
        return await this.imageTool.compareImageToPrompt(args.filename);
      case "pngInfo":
        return await this.imageTool.pngInfo(args.filename);
      case "listImageModels":
        return await this.imageTool.listImageModels();
      case "listImageLoras":
        return await this.imageTool.listImageLoras();
      case "getLoraDetails":
        return await this.imageTool.getLoraDetails(args.loraName);
      case "extractTextFromImage":
        return await this.imageTool.extractTextFromImage(args.filename);
      case "extractTextFromAudio":
        return await this.audioTool.extractTextFromAudio(args.filename);
      case "readXlsx":
        return await this.fileConversionTool.readXlsx(args.filename, args.sheetName, args.outputFormat, args.output);
      case "listXlsxSheets":
        return await this.fileConversionTool.listXlsxSheets(args.filename);
      case "createVerificationArtifact":
        return await this.taskManagementTool.createVerificationArtifact(
          args.status, args.task, args.artifact, args.checks, args.issues, args.meta
        );
      case "finishTaskAndQuit":
        return await this.taskManagementTool.finishTaskAndQuit(args.reasoning, args.details);
      case "escalateAndQuit":
        return await this.taskManagementTool.escalateAndQuit(args.reasoning, args.details);
      case "refuseAndQuit":
        return await this.taskManagementTool.refuseAndQuit(args.reasoning, args.details);
      default:
        if (toolName.startsWith("mcp__")) {
          return await this.executeMCPTool(toolName, args);
        }
        if (toolName.startsWith("skill__")) {
          return this.executeSkillTool(toolName, args);
        }
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  }

  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  private executeSkillTool(toolName: string, args: any): ToolResult {
    try {
      let cmd: string;
      if (toolName === 'skill__read_doc') {
        cmd = `mzke skill read ${this.shellQuote(String(args.name || ''))}`;
      } else if (toolName === 'skill__define_term') {
        cmd = `mzke skill def ${this.shellQuote(String(args.term || ''))}`;
      } else {
        const skillName = toolName.replace(/^skill__/, '');
        cmd = args.arg
          ? `mzke skill ${skillName} ${this.shellQuote(String(args.arg))}`
          : `mzke skill ${skillName}`;
      }
      const output = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
      return { success: true, output: output.trim() || 'Success' };
    } catch (error: any) {
      const stderr = error.stderr?.toString().trim();
      const stdout = error.stdout?.toString().trim();
      return { success: false, error: stderr || stdout || `Skill execution failed: ${error.message}` };
    }
  }

  private async executeMCPTool(toolName: string, args: any): Promise<ToolResult> {
    try {
      const mcpManager = getMCPManager();
      const result = await mcpManager.callTool(toolName, args);

      if (result.isError) {
        return { success: false, error: (result.content[0] as any)?.text || "MCP tool error" };
      }

      const output = result.content
        .map((item) => {
          if (item.type === "text") {
            return item.text;
          } else if (item.type === "resource") {
            return `Resource: ${item.resource?.uri || "Unknown"}`;
          }
          return String(item);
        })
        .join("\n");

      const serverNameMatch = toolName.match(/^mcp__(.+?)__/);
      if (serverNameMatch) {
        const serverName = serverNameMatch[1];
        mcpManager.invalidateCache(serverName);
      }

      return { success: true, output: output || "Success" };
    } catch (error: any) {
      return { success: false, error: `MCP tool execution error: ${error.message}` };
    }
  }
}