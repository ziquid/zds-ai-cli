#!/usr/bin/env node

// No global output suppression - let UI render normally

import React from "react";
import { render } from "ink";
import { program } from "commander";
import * as dotenv from "dotenv";
import { LLMAgent } from "./agent/llm-agent.js";
import ChatInterface from "./ui/components/chat-interface.js";
import { getSettingsManager } from "./utils/settings-manager.js";
import { ConfirmationService } from "./utils/confirmation-service.js";
import { ChatHistoryManager } from "./utils/chat-history-manager.js";
import { createMCPCommand } from "./commands/mcp.js";
import { getAuthConfig, validateApiKey } from "./utils/auth-helper.js";
import { getTextContent } from "./utils/content-utils.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { handleRephraseChoice, getRephraseMenuOptions } from "./utils/rephrase-handler.js";

// Read version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8")
);
const version = packageJson.version;

// Load environment variables
dotenv.config();

// No global output suppression functions needed

// Global reference to current agent for cleanup
let currentAgent: LLMAgent | null = null;

// Terminal restoration function
function restoreTerminal() {
  // Save chat history and messages if we have an active agent
  if (currentAgent) {
    try {
      const historyManager = ChatHistoryManager.getInstance();
      const currentHistory = currentAgent.getChatHistory();
      const currentMessages = currentAgent.getMessages();
      const sessionState = currentAgent.getSessionState();
      historyManager.saveContext(currentAgent.getSystemPrompt(), currentHistory, sessionState);
      historyManager.saveMessages(currentMessages);
    } catch (error) {
      // Silently ignore errors during emergency cleanup
    }
  }

  // Restore terminal to normal mode
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch (e) {
      // Ignore errors when setting raw mode
    }
  }

  // Restore cursor and clear any special terminal modes
  if (process.stdout.isTTY) {
    try {
      process.stdout.write('\x1b[?25h'); // Show cursor
      process.stdout.write('\x1b[0m');   // Reset all formatting
    } catch (e) {
      // Ignore errors
    }
  }
}

// Handle SIGINT (Ctrl+C) to restore terminal properly
process.on("SIGINT", async () => {
  // If there's an active agent, abort its current operation first
  if (currentAgent && typeof currentAgent.abortCurrentOperation === 'function') {
    currentAgent.abortCurrentOperation();
    // Give it a brief moment to process the abort
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  restoreTerminal();
  console.log("\n");
  process.exit(0);
});

process.on("SIGTERM", () => {
  restoreTerminal();
  console.log("\nGracefully shutting down...");
  process.exit(0);
});

// Handle uncaught exceptions to prevent hanging
process.on("uncaughtException", (error) => {
  restoreTerminal();
  console.error("Uncaught exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  restoreTerminal();
  console.error("Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Cleanup on normal exit
process.on("exit", () => {
  restoreTerminal();
});

// Ensure user settings are initialized
function ensureUserSettingsDirectory(): void {
  try {
    const manager = getSettingsManager();
    // This will create default settings if they don't exist
    manager.loadUserSettings();
  } catch (error) {
    // Silently ignore errors during setup
  }
}

// Save command line API key to user settings file (baseURL is not saved - it's for override only)
async function saveCommandLineSettings(
  apiKey?: string
): Promise<void> {
  try {
    const manager = getSettingsManager();

    // Update with command line values
    if (apiKey) {
      manager.updateUserSetting("apiKey", apiKey);
      console.log("✅ API key saved to ~/.grok/user-settings.json");
    }
  } catch (error) {
    console.warn(
      "⚠️ Could not save settings to file:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }
}

// Show all available tools (internal and MCP)
async function showAllTools(debugLogFile?: string): Promise<void> {
  try {
    // Ensure MCP servers are initialized
    const { getMCPManager } = await import('./grok/tools.js');
    const mcpManager = getMCPManager();
    await mcpManager.ensureServersInitialized();

    // Create a temporary agent and use introspect tool (no startup hook needed for listing tools)
    const { LLMAgent } = await import('./agent/llm-agent.js');
    const tempAgent = new LLMAgent("dummy");
    await tempAgent.initialize();
    const result = await tempAgent["introspect"].introspect("tools");

    if (result.success) {
      console.log(result.output);
    } else {
      console.error("Error:", result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error("Error listing tools:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
  }
}

// Show context statistics (read-only, no state changes)
async function showContextStats(contextFile?: string): Promise<void> {
  try {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    // Determine context file path
    let filePath: string;
    if (contextFile) {
      filePath = contextFile;
    } else {
      filePath = path.default.join(os.default.homedir(), '.grok', 'messages.json');
    }

    // Read messages file directly without modifying anything
    const messagesData = fs.default.readFileSync(filePath, 'utf-8');
    const messages = JSON.parse(messagesData);

    // Import token counter and count tokens
    const { TokenCounter } = await import('./utils/token-counter.js');
    const tokenCounter = new TokenCounter();
    const current = tokenCounter.countMessageTokens(messages);
    const max = 128000;
    const percent = Math.ceil((current / max) * 100);

    // Round up to nearest KB (1000-based)
    const currentKB = Math.ceil(current / 1000);
    const maxKB = Math.ceil(max / 1000);

    // Format percentage with leading spaces to always show 3 digits
    const percentStr = percent.toString().padStart(3, ' ');

    console.log(`${currentKB}k/${maxKB}k/${percentStr}%`);
  } catch (error) {
    console.error("Error reading context stats:", error instanceof Error ? error.message : "Unknown error");
    process.exit(1);
  }
}

// Handle commit-and-push command in headless mode
async function handleCommitAndPushHeadless(
  apiKey: string,
  baseURL?: string,
  model?: string,
  maxToolRounds?: number,
  debugLogFile?: string,
  temperature?: number
): Promise<void> {
  try {
    const { createLLMAgent } = await import('./utils/startup-hook.js');
    const agent = await createLLMAgent(apiKey, baseURL, model, maxToolRounds, debugLogFile, true, temperature);
    currentAgent = agent; // Store reference for cleanup

    // Configure confirmation service for headless mode (auto-approve all operations)
    const confirmationService = ConfirmationService.getInstance();
    confirmationService.setSessionFlag("allOperations", true);

    console.log("🤖 Processing commit and push...\n");
    console.log("> /commit-and-push\n");

    // First check if there are any changes at all
    const initialStatusResult = await agent.executeCommand(
      "git status --porcelain"
    );

    if (!initialStatusResult.success || !initialStatusResult.output?.trim()) {
      console.log("❌ No changes to commit. Working directory is clean.");
      process.exit(1);
    }

    console.log("✅ git status: Changes detected");

    // Add all changes
    const addResult = await agent.executeCommand("git add .");

    if (!addResult.success) {
      console.log(
        `❌ git add: ${addResult.error || "Failed to stage changes"}`
      );
      process.exit(1);
    }

    console.log("✅ git add: Changes staged");

    // Get staged changes for commit message generation
    const diffResult = await agent.executeCommand("git diff --cached");

    // Generate commit message using AI
    const commitPrompt = `Generate a concise, professional git commit message for these changes:

Git Status:
${initialStatusResult.output}

Git Diff (staged changes):
${diffResult.output || "No staged changes shown"}

Follow conventional commit format (feat:, fix:, docs:, etc.) and keep it under 72 characters.
Respond with ONLY the commit message, no additional text.`;

    console.log("🤖 Generating commit message...");

    const commitMessageEntries = await agent.processUserMessage(commitPrompt);
    let commitMessage = "";

    // Extract the commit message from the AI response
    for (const entry of commitMessageEntries) {
      const content = getTextContent(entry.content);
      if (entry.type === "assistant" && content.trim()) {
        commitMessage = content.trim();
        break;
      }
    }

    if (!commitMessage) {
      console.log("❌ Failed to generate commit message");
      process.exit(1);
    }

    // Clean the commit message
    const cleanCommitMessage = commitMessage.replace(/^["']|["']$/g, "");
    console.log(`✅ Generated commit message: "${cleanCommitMessage}"`);

    // Execute the commit
    const commitCommand = `git commit -m "${cleanCommitMessage}"`;
    const commitResult = await agent.executeCommand(commitCommand);

    if (commitResult.success) {
      console.log(
        `✅ git commit: ${
          commitResult.output?.split("\n")[0] || "Commit successful"
        }`
      );

      // If commit was successful, push to remote
      // First try regular push, if it fails try with upstream setup
      let pushResult = await agent.executeCommand("git push");

      if (
        !pushResult.success &&
        pushResult.error?.includes("no upstream branch")
      ) {
        console.log("🔄 Setting upstream and pushing...");
        pushResult = await agent.executeCommand("git push -u origin HEAD");
      }

      if (pushResult.success) {
        console.log(
          `✅ git push: ${
            pushResult.output?.split("\n")[0] || "Push successful"
          }`
        );
        process.exit(0);
      } else {
        console.log(`❌ git push: ${pushResult.error || "Push failed"}`);
        process.exit(1);
      }
    } else {
      console.log(`❌ git commit: ${commitResult.error || "Commit failed"}`);
      process.exit(1);
    }
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "message" in error) {
      console.error("❌ Error during commit and push:", (error as any).message);
    } else {
      console.error("❌ Error during commit and push:", error);
    }
    process.exit(1);
  }
}

// Headless mode processing function
async function processPromptHeadless(
  prompt: string,
  apiKey: string,
  baseURL?: string,
  model?: string,
  maxToolRounds?: number,
  fresh?: boolean,
  debugLogFile?: string,
  autoApprove?: boolean,
  autoApproveCommands?: string[],
  temperature?: number,
  maxTokens?: number
): Promise<void> {
  try {
    const { createLLMAgent } = await import('./utils/startup-hook.js');
    const agent = await createLLMAgent(apiKey, baseURL, model, maxToolRounds, debugLogFile, true, temperature, maxTokens);
    currentAgent = agent; // Store reference for cleanup

    // Configure confirmation service for headless mode
    const confirmationService = ConfirmationService.getInstance();
    if (autoApprove) {
      confirmationService.setSessionFlag("allOperations", true);
    } else if (autoApproveCommands && autoApproveCommands.length > 0) {
      confirmationService.setApprovedCommands(autoApproveCommands);
    } else {
      // If no approval settings provided, fail with helpful error
      throw new Error(
        "Headless mode requires explicit approval settings. Use --auto-approve for all operations or --auto-approve-commands for specific commands."
      );
    }

    // Load existing chat history unless fresh session
    const { ChatHistoryManager } = await import("./utils/chat-history-manager.js");
    const historyManager = ChatHistoryManager.getInstance();

    if (!fresh) {
      const { systemPrompt, chatHistory: existingHistory, sessionState } = historyManager.loadContext();
      await agent.loadInitialHistory(existingHistory, systemPrompt);

      // Restore session state (persona, mood, task, backend, model)
      if (sessionState) {
        await agent.restoreSessionState(sessionState);
      }
    } else {
      // Clear existing history file for fresh session (creates backup first)
      historyManager.clearHistory();
      // Reset confirmation service session flags
      confirmationService.resetSession();
    }

    // Check if this is a slash command first
    const { processSlashCommand } = await import('./utils/slash-commands.js');
    const slashCommandHandled = await processSlashCommand(prompt, {
      agent,
      addChatEntry: (entry) => {
        // In headless mode, we don't maintain a UI chat history
        // Output is handled directly by the slash command processor
      },
      isHeadless: true
    });

    // If slash command was handled, exit cleanly
    if (slashCommandHandled) {
      process.exit(0);
    }

    // Otherwise, process as normal user message
    const chatEntries = await agent.processUserMessage(prompt);

    // Collect all assistant responses with content (excluding the user prompt entry)
    // Skip assistant messages that have tool_calls - those are intermediate, not final responses
    const assistantResponses: string[] = [];
    for (const entry of chatEntries) {
      const content = getTextContent(entry.content);
      if (entry.type === "assistant" && content && content.trim() && !entry.tool_calls) {
        assistantResponses.push(content);
      }
    }

    // Save updated chat history and messages
    const currentHistory = agent.getChatHistory();
    const currentMessages = agent.getMessages();
    const sessionState = agent.getSessionState();
    historyManager.saveContext(agent.getSystemPrompt(), currentHistory, sessionState);
    historyManager.saveMessages(currentMessages);

    // Output all assistant responses
    if (assistantResponses.length > 0) {
      console.log(assistantResponses.join('\n'));
    } else {
      console.log("I understand, but I don't have a specific response.");
    }

    // Exit cleanly after processing
    process.exit(0);
  } catch (error: unknown) {
    // Output error as plain text
    if (error && typeof error === "object" && "message" in error) {
      console.log(`Error: ${(error as { message: string }).message}`);
    } else {
      console.log(`Error: ${String(error)}`);
    }
    process.exit(1);
  }
}

program
  .name("zai-cli")
  .description(
    "A conversational AI CLI tool with text editor capabilities"
  )
  .version(version)
  .option("-d, --directory <dir>", "set working directory", process.cwd())
  .option("-k, --api-key <key>", "Grok API key (or set GROK_API_KEY env var)")
  .option(
    "-b, --backend <name>",
    "Backend display name (e.g., grok, openai, claude)"
  )
  .option(
    "-u, --base-url <url>",
    "API base URL (or set GROK_BASE_URL env var)"
  )
  .option(
    "-m, --model <model>",
    "AI model to use (e.g., grok-code-fast-1, grok-4-latest) (or set GROK_MODEL env var)"
  )
  .option(
    "-t, --temperature <temp>",
    "temperature for API requests (0.0-2.0, default: 0.7)",
    (value) => {
      const temp = parseFloat(value);
      if (isNaN(temp) || temp < 0 || temp > 2) {
        console.error(`Error: Temperature must be between 0.0 and 2.0 (got ${value})`);
        process.exit(1);
      }
      return temp;
    },
    0.7
  )
  .option(
    "--max-tokens <tokens>",
    "maximum tokens for API responses (positive integer, no default = API default)"
  )
  .option(
    "-p, --prompt [prompt]",
    "process a single prompt and exit (headless mode). If no prompt provided, reads from stdin"
  )
  .option(
    "--max-tool-rounds <rounds>",
    "maximum number of tool execution rounds (default: 400)",
    "400"
  )
  .option(
    "--fresh",
    "start with a fresh session (don't load previous chat history)"
  )
  .option(
    "--auto-approve",
    "auto-approve all operations without confirmation prompts"
  )
  .option(
    "--auto-approve-commands <commands>",
    "comma-separated list of commands to auto-approve (e.g., 'chdir,list_files,pwd')"
  )
  .option(
    "-c, --context <file>",
    "path to context persistence file (default: ~/.zds-ai/context.json)"
  )
  .option(
    '--no-ink',
    'disable Ink UI and use plain console input/output'
  )
  .option(
    "--debug-log <file>",
    "redirect MCP server debug output to log file instead of suppressing"
  )
  .option(
    "--show-all-tools",
    "list all available tools (internal and MCP) and exit"
  )
  .option(
    "--show-context-stats",
    "display token usage stats for the specified context file and exit"
  )
  .option(
    "-s, --settings <file>",
    "path to user settings file (default: ~/.zds-ai/cli-settings.json)"
  )
  .argument("[message...]", "Initial message to send to the AI")
  .allowExcessArguments(true)
  .action(async (message, options) => {
    if (options.directory) {
      try {
        process.chdir(options.directory);
      } catch (error: unknown) {
        console.error(
          `Error changing directory to ${options.directory}:`,
          error instanceof Error ? error.message : String(error)
        );
        process.exit(1);
      }
    }

    // Set custom user settings path if provided
    if (options.settings) {
      const { SettingsManager } = await import('./utils/settings-manager.js');
      SettingsManager.setCustomUserSettingsPath(options.settings);
    }

    // Handle --show-all-tools flag
    if (options.showAllTools) {
      await showAllTools(options.debugLog);
      process.exit(0);
    }

    // Handle --show-context-stats flag
    if (options.showContextStats) {
      await showContextStats(options.context);
      process.exit(0);
    }

    try {
      // Get authentication and backend configuration
      const authConfig = getAuthConfig({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        model: options.model,
      });

      const { apiKey, baseURL, model } = authConfig;

      // Set backend display name if provided via -b flag
      if (options.backend) {
        process.env.GROK_BACKEND_DISPLAY_NAME = options.backend;
      }

      const maxToolRounds = parseInt(options.maxToolRounds) || 400;

      // Validate API key
      try {
        validateApiKey(apiKey);
      } catch (error: any) {
        console.error(`❌ Error: ${error.message}`);
        process.exit(1);
      }

      // Note: API key from --api-key flag is NOT saved to user settings
      // It's only used for this session. Use the interactive prompt to save it permanently.

      ensureUserSettingsDirectory();

      // Set custom context file path if provided
      if (options.context) {
        const { ChatHistoryManager } = await import("./utils/chat-history-manager.js");
        ChatHistoryManager.setCustomHistoryPath(options.context);
      }

      // Headless mode: process prompt and exit
      if (options.prompt !== undefined) {
        let prompt = options.prompt;

        // If prompt is empty or just whitespace, read from stdin
        if (!prompt || !prompt.trim()) {
          const stdinData = await new Promise<string>((resolve, reject) => {
            let data = '';
            const timeout = setTimeout(() => {
              reject(new Error('Timeout waiting for stdin (5 seconds)'));
            }, 5000);

            process.stdin.on('data', (chunk) => {
              data += chunk;
            });
            process.stdin.on('end', () => {
              clearTimeout(timeout);
              resolve(data);
            });
            process.stdin.on('error', (err) => {
              clearTimeout(timeout);
              reject(err);
            });
          });
          prompt = stdinData.trim();
        }

        if (!prompt) {
          console.error("Error: No prompt provided via argument or stdin");
          process.exit(1);
        }

        // Parse approved commands for headless mode
        const approvedCommands = options.autoApproveCommands
          ? options.autoApproveCommands
              .split(',')
              .map(cmd => cmd.trim())
              .filter(cmd => cmd.length > 0)
          : [];

        const temperature = options.temperature ?? 0.7;
        const maxTokens = options.maxTokens ? parseInt(options.maxTokens) : undefined;

        await processPromptHeadless(
          prompt,
          apiKey,
          baseURL,
          model,
          maxToolRounds,
          options.fresh,
          options.debugLog,
          options.autoApprove,
          approvedCommands,
          temperature,
          maxTokens
        );
        return;
      }

      // Interactive mode: launch UI

      // Create agent for interactive mode only
      const { createLLMAgent } = await import('./utils/startup-hook.js');
      // Run startup hook for fresh sessions or when context doesn't have a system prompt
      const { ChatHistoryManager } = await import('./utils/chat-history-manager.js');
      const historyManager = ChatHistoryManager.getInstance();
      const loadedContext = options.fresh ? { systemPrompt: "", chatHistory: [] } : historyManager.loadContext();
      const hasSystemPrompt = loadedContext.systemPrompt && loadedContext.systemPrompt.trim().length > 0;
      const runStartupHook = !hasSystemPrompt; // Run hook if no system prompt exists
      const temperature = options.temperature ?? 0.7;
      const maxTokens = options.maxTokens ? parseInt(options.maxTokens) : undefined;
      const agent = await createLLMAgent(apiKey, baseURL, model, maxToolRounds, options.debugLog, runStartupHook, temperature, maxTokens);
      currentAgent = agent; // Store reference for cleanup

      // Configure confirmation service if auto-approve is enabled
      const confirmationService = ConfirmationService.getInstance();
      if (options.autoApprove) {
        confirmationService.setSessionFlag("allOperations", true);
      } else if (options.autoApproveCommands) {
        // Parse comma-separated commands and set them as approved
        const commands = options.autoApproveCommands
          .split(',')
          .map(cmd => cmd.trim())
          .filter(cmd => cmd.length > 0);
        confirmationService.setApprovedCommands(commands);
      }

      console.log("⚡ Starting ZDS AI Agents CLI...\n");

      // Support variadic positional arguments for multi-word initial message
      let messageArray = Array.isArray(message) ? message : (message ? [message] : []);

      // Trim all elements (Commander may add spaces)
      messageArray = messageArray.map(arg => arg.trim());

      // Check if --no-ink is in the message array (happens when flag comes after message due to variadic args)
      const hasNoInkInMessage = messageArray.includes('--no-ink');

      // If --no-ink was in message array, manually set option (Commander didn't parse it as flag)
      if (hasNoInkInMessage) {
        options.ink = false;
      }

      // Filter out any CLI flags from message array (in case they leaked through)
      messageArray = messageArray.filter(arg => !arg.startsWith('-'));

      // Join message
      const initialMessage = messageArray.join(" ").trim();
   // Optimize console output for plain mode to reduce flickering

      if (!options.ink) {
        // Plain console mode
        (global as any).isInkMode = false;
        const prompts = await import('prompts');

        // Load chat history if not a fresh session
        // IMPORTANT: Must load history BEFORE initialize() to preserve instance hook output
        if (!options.fresh) {
          const { systemPrompt: loadedSystemPrompt, chatHistory: loadedHistory, sessionState } = historyManager.loadContext();
          if (loadedHistory.length > 0) {
            // Save any instance hook messages that were added during initialize()
            const currentHistory = agent.getChatHistory();
            const instanceHookMessages = currentHistory.filter(entry =>
              entry.type === 'system' && entry.timestamp > new Date(Date.now() - 1000)
            );

            // Load old history
            await agent.loadInitialHistory(loadedHistory, loadedSystemPrompt);

            // Re-append fresh instance hook messages
            if (instanceHookMessages.length > 0) {
              const agentHistory = agent.getChatHistory();
              agent.setChatHistory([...agentHistory, ...instanceHookMessages]);
            }

            // Restore session state
            if (sessionState) {
              await agent.restoreSessionState(sessionState);
            }
          }
        } else {
          // Clear existing history file for fresh session (creates backup first)
          historyManager.clearHistory();
          // Reset confirmation service session flags
          confirmationService.resetSession();
        }

        // Helper function to save context
        const saveContext = () => {
          const chatHistory = agent.getChatHistory();
          const messages = agent.getMessages();
          const sessionState = agent.getSessionState();
          historyManager.saveContext(agent.getSystemPrompt(), chatHistory, sessionState);
          historyManager.saveMessages(messages);
        };

        // Save initial context after initialization completes
        // This ensures context file exists even on fresh sessions before first message
        saveContext();

        // Process initial message if provided
        if (initialMessage) {
          try {

            for await (const chunk of agent.processUserMessageStream(initialMessage)) {
              switch (chunk.type) {
                case 'user_message':
                  // Display user message when agent yields it
                  if (chunk.userEntry) {
                    console.log(`> ${chunk.userEntry.content}`);
                  }
                  break;
                case 'content':
                  if (chunk.content) {
                    process.stdout.write(chunk.content);
                  }
                  break;
                case 'tool_calls':
                  if (chunk.tool_calls) {
                    chunk.tool_calls.forEach(toolCall => {
                      console.log(`\n🔧 ${toolCall.function.name}...`);
                    });
                  }
                  break;
                case 'tool_result':
                  // Tool results are usually not shown to user, just processed
                  break;
                case 'done':
                  console.log(); // Add newline after response
                  // Save context after processing completes
                  saveContext();
                  break;
              }
            }
          } catch (error) {
            console.log('DEBUG: Error in streaming:', error);
          }
        }

        // Interactive loop
        while (true) {
          try {
            // Write our own prompt without symbols
            process.stdout.write('> ');

            const result = await prompts.default({
              type: 'text',
              name: 'input',
              message: '',
              initial: ''
            }, {
              onCancel: () => {
                saveContext();
                process.exit(0);
              }
            });

            if (result.input === undefined) {
              break;
            }

            if (!result.input) {
              if (process.stdin.isTTY) {
                // Blank line: treat as 'continue'
                result.input = 'continue';
              } else {
                continue;
              }
            }

            const input = result.input.trim();

            // Check for pending context edit confirmation
            const pendingEdit = agent.getPendingContextEditSession();
            if (pendingEdit) {
              const trimmed = input.toLowerCase();
              const { tmpJsonPath, contextFilePath } = pendingEdit;

              if (trimmed === 'y' || trimmed === 'yes') {
                // User confirmed - replace context
                const fs = await import('fs');
                const { ChatHistoryManager } = await import('./utils/chat-history-manager.js');

                fs.copyFileSync(tmpJsonPath, contextFilePath);

                // Reload context from file
                const historyManager = ChatHistoryManager.getInstance();
                const { systemPrompt: reloadedSystemPrompt, chatHistory: reloadedHistory } = historyManager.loadContext();

                // Update agent's chat history
                agent.setChatHistory(reloadedHistory);

                // Update system prompt - regenerate if empty
                if (reloadedSystemPrompt && reloadedSystemPrompt.trim()) {
                  agent.setSystemPrompt(reloadedSystemPrompt);
                } else {
                  await agent.buildSystemMessage();
                }

                console.log('✓ Context replaced with edited version');

                // Clean up temp file
                try {
                  fs.unlinkSync(tmpJsonPath);
                } catch (err) {
                  // Ignore cleanup errors
                }
              } else {
                // User cancelled
                const fs = await import('fs');
                console.log('Context edit cancelled');

                // Clean up temp file
                try {
                  fs.unlinkSync(tmpJsonPath);
                } catch (err) {
                  // Ignore cleanup errors
                }
              }

              // Clear pending state
              agent.clearPendingContextEditSession();
              continue;
            }

            if (input === 'exit' || input === 'quit') {
              console.log('👋 Goodbye!');
              process.exit(0);
            }

            // Handle slash commands
            const { processSlashCommand } = await import('./utils/slash-commands.js');
            const slashCommandHandled = await processSlashCommand(input, {
              agent,
              addChatEntry: (entry) => {
                // In no-ink mode, output directly to console
                if (entry.type === 'assistant' || entry.type === 'system') {
                  console.log(entry.content);
                }
              },
              isHeadless: false,  // no-ink is interactive, not headless
              isInkMode: false    // plain console mode
            });

            if (slashCommandHandled) {
              // Command was handled, continue to next prompt
              continue;
            }

            // Legacy: Handle /context commands that need special UI handling
            if (input.startsWith('/context ')) {
              const subcommand = input.substring(9).trim();

              if (subcommand === 'view') {
                try {
                  const fs = await import('fs');
                  const { spawn } = await import('child_process');

                  // Get context file path
                  const { ChatHistoryManager } = await import('./utils/chat-history-manager.js');
                  const historyManager = ChatHistoryManager.getInstance();
                  const contextFilePath = historyManager.getContextFilePath();

                  // Create temp file next to context file
                  const tmpMdPath = `${contextFilePath}.md.tmp`;

                  // Convert context to markdown
                  const markdown = await agent.convertContextToMarkdown();
                  fs.writeFileSync(tmpMdPath, markdown, 'utf-8');

                  // Get viewer command
                  const settings = await import('./utils/settings-manager.js');
                  const settingsManager = settings.getSettingsManager();
                  const viewerCommand = settingsManager.getContextViewHelper();

                  // Spawn viewer
                  const viewerProcess = spawn(viewerCommand, [tmpMdPath], {
                    stdio: 'inherit',
                    shell: true,
                  });

                  await new Promise<void>((resolve) => {
                    viewerProcess.on('close', () => {
                      try {
                        fs.unlinkSync(tmpMdPath);
                      } catch (err) {
                        // Ignore cleanup errors
                      }
                      resolve();
                    });
                  });

                  continue;
                } catch (error) {
                  console.error('❌ Failed to view context:', error instanceof Error ? error.message : String(error));
                  continue;
                }
              } else if (subcommand === 'edit') {
                try {
                  const fs = await import('fs');
                  const path = await import('path');
                  const { spawn } = await import('child_process');

                  // Get context file path
                  const { ChatHistoryManager } = await import('./utils/chat-history-manager.js');
                  const historyManager = ChatHistoryManager.getInstance();
                  const contextFilePath = historyManager.getContextFilePath();

                  // If context file doesn't exist yet, save it first
                  if (!fs.existsSync(contextFilePath)) {
                    saveContext();
                  }

                  // Create temp copy
                  const tmpJsonPath = `${contextFilePath}.tmp`;
                  fs.copyFileSync(contextFilePath, tmpJsonPath);

                  // Get editor command
                  const settings = await import('./utils/settings-manager.js');
                  const settingsManager = settings.getSettingsManager();
                  const editorCommand = settingsManager.getContextEditHelper();

                  // Spawn editor
                  const editorProcess = spawn(editorCommand, [tmpJsonPath], {
                    stdio: 'inherit',
                    shell: true,
                  });

                  await new Promise<void>((resolve) => {
                    editorProcess.on('close', () => {
                      resolve();
                    });
                  });

                  // Validate edited JSON
                  let isValid = false;
                  let validationError = '';
                  try {
                    const editedContent = fs.readFileSync(tmpJsonPath, 'utf-8');
                    JSON.parse(editedContent);
                    isValid = true;
                  } catch (error) {
                    validationError = error instanceof Error ? error.message : String(error);
                  }

                  if (!isValid) {
                    console.log(`❌ Edited context file contains invalid JSON: ${validationError}`);
                    try {
                      fs.unlinkSync(tmpJsonPath);
                    } catch (err) {
                      // Ignore cleanup errors
                    }
                    continue;
                  }

                  // Store pending edit in agent
                  agent.setPendingContextEditSession(tmpJsonPath, contextFilePath);

                  // Print prompt
                  console.log('🔧 System:   Editor closed. Replace context with edited version? (y/n)');
                  continue;
                } catch (error) {
                  console.error('❌ Failed to edit context:', error instanceof Error ? error.message : String(error));
                  continue;
                }
              } else if (subcommand === 'reload') {
                try {
                  const { ChatHistoryManager } = await import('./utils/chat-history-manager.js');
                  const historyManager = ChatHistoryManager.getInstance();
                  const { systemPrompt: reloadedSystemPrompt, chatHistory: reloadedHistory } = historyManager.loadContext();

                  // Update agent's chat history
                  agent.setChatHistory(reloadedHistory);

                  // Update system prompt - regenerate if empty
                  if (reloadedSystemPrompt && reloadedSystemPrompt.trim()) {
                    agent.setSystemPrompt(reloadedSystemPrompt);
                  } else {
                    await agent.buildSystemMessage();
                  }

                  console.log('✓ Context reloaded from file');
                  continue;
                } catch (error) {
                  console.error('❌ Failed to reload context:', error instanceof Error ? error.message : String(error));
                  continue;
                }
              }
            }

            if (input) {
              for await (const chunk of agent.processUserMessageStream(input)) {
                switch (chunk.type) {
                  case 'user_message':
                    // User message already displayed by prompts library, skip
                    break;
                  case 'content':
                    if (chunk.content) {
                      process.stdout.write(chunk.content);
                    }
                    break;
                  case 'tool_calls':
                    if (chunk.tool_calls) {
                      chunk.tool_calls.forEach(toolCall => {
                        console.log(`\n🔧 ${toolCall.function.name}...`);
                      });
                    }
                    break;
                  case 'tool_result':
                    // Tool results are usually not shown to user, just processed
                    break;
                  case 'done':
                    console.log(); // Add newline after response
                    // Save context after processing completes
                    saveContext();
                    break;
                }
              }

              // Check if this was a rephrase command and show menu
              const rephraseState = agent.getRephraseState();
              if (rephraseState) {
                console.log('\nRephrase options:');
                const menuOptions = getRephraseMenuOptions(rephraseState.messageType);
                menuOptions.forEach(option => console.log(`  ${option}`));

                let rephraseChoice: string | undefined;
                while (!rephraseChoice || !['1', '2', '3', '4', '5'].includes(rephraseChoice)) {
                  const choiceResult = await prompts.default({
                    type: 'text',
                    name: 'choice',
                    message: 'Choose option (1-5):',
                    initial: ''
                  });

                  if (choiceResult.choice === undefined) {
                    // User cancelled (Ctrl+C), treat as option 5
                    rephraseChoice = '5';
                  } else {
                    rephraseChoice = choiceResult.choice.trim();
                  }
                }

                // Use shared handler to process the choice
                const result = handleRephraseChoice(rephraseChoice, agent);
                saveContext();

                // Handle options that need re-prompting (3 and 4)
                if (result.preFillPrompt && (rephraseChoice === '3' || rephraseChoice === '4')) {
                  const promptMessage = rephraseChoice === '3'
                    ? '\nTry again (edit command if needed):'
                    : rephraseState.messageType === 'user'
                      ? '\nResending as system message:'
                      : '\nResending as user message:';

                  console.log(promptMessage);

                  const retryResult = await prompts.default({
                    type: 'text',
                    name: 'input',
                    message: '',
                    initial: result.preFillPrompt
                  });

                  if (retryResult.input && retryResult.input.trim()) {
                    // Process the new command
                    for await (const chunk of agent.processUserMessageStream(retryResult.input.trim())) {
                      switch (chunk.type) {
                        case 'user_message':
                          break;
                        case 'content':
                          if (chunk.content) {
                            process.stdout.write(chunk.content);
                          }
                          break;
                        case 'tool_calls':
                          if (chunk.tool_calls) {
                            chunk.tool_calls.forEach(toolCall => {
                              console.log(`\n🔧 ${toolCall.function.name}...`);
                            });
                          }
                          break;
                        case 'tool_result':
                          break;
                        case 'done':
                          console.log();
                          saveContext();
                          break;
                      }
                    }

                    // Check if there's a new rephrase state to handle
                    const newRephraseState = agent.getRephraseState();
                    if (newRephraseState) {
                      // This will be handled in the next iteration of the loop
                      continue;
                    }
                  }
                } else {
                  // For options 1, 2, and 5, show confirmation message
                  if (rephraseChoice === '1') {
                    console.log('✓ Kept as new response');
                  } else if (rephraseChoice === '2') {
                    console.log('✓ Original response replaced');
                  } else if (rephraseChoice === '5') {
                    console.log('✓ Rephrase cancelled');
                  }
                }
              }
            }
          } catch (error) {
            // Handle Ctrl+C or other interruptions
            // Save context before exiting
            saveContext();
            console.log('\n👋 Goodbye!');
            process.exit(0);
          }
        }

        // Plain console mode loop exited (shouldn't happen, but just in case)
        return;
      }

      // Ink mode (GUI) - only reached if options.ink is true
      // Clear terminal screen for ink mode
      process.stdout.write('\x1b[2J\x1b[0f');

      const inkInstance = render(React.createElement(ChatInterface, {
        agent,
        initialMessage,
        fresh: options.fresh
      }));

      // Store Ink instance globally so components can unmount/remount for external processes
      (global as any).inkInstance = inkInstance;
      (global as any).isInkMode = true;
    } catch (error: any) {
      console.error("❌ Error initializing ZDS AI CLI:", error.message);
      process.exit(1);
    }
  });

// Git subcommand
const gitCommand = program
  .command("git")
  .description("Git operations with AI assistance");

gitCommand
  .command("commit-and-push")
  .description("Generate AI commit message and push to remote")
  .option("-d, --directory <dir>", "set working directory", process.cwd())
  .option("-k, --api-key <key>", "Grok API key (or set GROK_API_KEY env var)")
  .option(
    "-b, --backend <name>",
    "Backend display name (e.g., grok, openai, claude)"
  )
  .option(
    "-u, --base-url <url>",
    "API base URL (or set GROK_BASE_URL env var)"
  )
  .option(
    "-m, --model <model>",
    "AI model to use (e.g., grok-code-fast-1, grok-4-1-latest) (or set GROK_MODEL env var)"
  )
  .option(
    "-t, --temperature <temp>",
    "temperature for API requests (0.0-2.0, default: 0.7)",
    (value) => {
      const temp = parseFloat(value);
      if (isNaN(temp) || temp < 0 || temp > 2) {
        console.error(`Error: Temperature must be between 0.0 and 2.0 (got ${value})`);
        process.exit(1);
      }
      return temp;
    },
    0.7
  )
  .option(
    "--max-tokens <tokens>",
    "maximum tokens for API responses (positive integer, no default = API default)"
  )
  .option(
    "--max-tool-rounds <rounds>",
    "maximum number of tool execution rounds (default: 400)",
    "400"
  )
  .option(
    "--debug-log <file>",
    "redirect MCP server debug output to log file instead of suppressing"
  )
  .action(async (options) => {
    if (options.directory) {
      try {
        process.chdir(options.directory);
      } catch (error: unknown) {
        const message =
          error && typeof error === "object" && "message" in error && typeof (error as any).message === "string"
            ? (error as any).message
            : String(error);
        console.error(
          `Error changing directory to ${options.directory}:`,
          message
        );
        process.exit(1);
      }
    }

    try {
      // Get authentication and backend configuration
      const authConfig = getAuthConfig({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        model: options.model,
      });

      const { apiKey, baseURL, model } = authConfig;

      // Set backend display name if provided via -b flag
      if (options.backend) {
        process.env.GROK_BACKEND_DISPLAY_NAME = options.backend;
      }

      const maxToolRounds = parseInt(options.maxToolRounds) || 400;
      const temperature = options.temperature ?? 0.7;

      // Validate API key
      try {
        validateApiKey(apiKey);
      } catch (error: unknown) {
        const message =
          error && typeof error === "object" && "message" in error && typeof (error as any).message === "string"
            ? (error as any).message
            : String(error);
        console.error(`❌ Error: ${message}`);
        process.exit(1);
      }

      // Note: API key from --api-key flag is NOT saved to user settings
      // It's only used for this session. Use the interactive prompt to save it permanently.

      await handleCommitAndPushHeadless(apiKey, baseURL, model, maxToolRounds, options.debugLog, temperature);
    } catch (error: unknown) {
      const message =
        error && typeof error === "object" && "message" in error && typeof (error as any).message === "string"
          ? (error as any).message
          : String(error);
      console.error("❌ Error during commit and push:", message);
      process.exit(1);
    }
  });

program.parse(process.argv);
