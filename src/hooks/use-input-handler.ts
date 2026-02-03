import { useState, useMemo, useEffect, useRef } from "react";
import { useInput } from "ink";
import { LLMAgent, ChatEntry } from "../agent/llm-agent.js";
import { ConfirmationService } from "../utils/confirmation-service.js";
import { ChatHistoryManager } from "../utils/chat-history-manager.js";
import { useEnhancedInput, Key } from "./use-enhanced-input.js";
import { HELP_TEXT } from "../utils/slash-commands.js";

import { filterCommandSuggestions } from "../ui/components/command-suggestions.js";
import { loadModelConfig, updateCurrentModel } from "../utils/model-config.js";
import { handleRephraseChoice } from "../utils/rephrase-handler.js";

// Timeout (ms) for double ESC detection
const DOUBLE_ESC_TIMEOUT_MS = 500;

interface UseInputHandlerProps {
  agent: LLMAgent;
  chatHistory: ChatEntry[];
  setChatHistory: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  setIsProcessing: (processing: boolean) => void;
  setIsStreaming: (streaming: boolean) => void;
  setTokenCount: (count: number) => void;
  setTotalTokenUsage: (updater: number | ((prev: number) => number)) => void;
  setProcessingTime: (time: number) => void;
  processingStartTime: React.MutableRefObject<number>;
  isProcessing: boolean;
  isStreaming: boolean;
  isConfirmationActive?: boolean;
  totalTokenUsage: number;
}

interface CommandSuggestion {
  command: string;
  description: string;
}

interface ModelOption {
  model: string;
}

export function useInputHandler({
  agent,
  chatHistory,
  setChatHistory,
  setIsProcessing,
  setIsStreaming,
  setTokenCount,
  setTotalTokenUsage,
  setProcessingTime,
  processingStartTime,
  isProcessing,
  isStreaming,
  isConfirmationActive = false,
  totalTokenUsage,
}: UseInputHandlerProps) {
  // Track current token count for accumulation
  const currentTokenCount = useRef(0);
  const [showCommandSuggestions, setShowCommandSuggestions] = useState(false);
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);
  const [showModelSelection, setShowModelSelection] = useState(false);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [showRephraseMenu, setShowRephraseMenu] = useState(false);
  const [selectedRephraseIndex, setSelectedRephraseIndex] = useState(0);
  const [autoEditEnabled, setAutoEditEnabled] = useState(() => {
    const confirmationService = ConfirmationService.getInstance();
    const sessionFlags = confirmationService.getSessionFlags();
    return sessionFlags.allOperations;
  });

  const lastEscapeTime = useRef(0);
  const wasCancelled = useRef(false);

  const handleEscape = () => {
    const now = Date.now();
    if (now - lastEscapeTime.current < DOUBLE_ESC_TIMEOUT_MS) {
      // Double ESC: clear input
      setInput("");
      setCursorPosition(0);
      lastEscapeTime.current = 0;
      return;
    }
    lastEscapeTime.current = now;

    // Single ESC: cancel current action or close menus
    if (showCommandSuggestions) {
      setShowCommandSuggestions(false);
      setSelectedCommandIndex(0);
      return;
    }
    if (showModelSelection) {
      setShowModelSelection(false);
      setSelectedModelIndex(0);
      return;
    }
    if (showRephraseMenu) {
      // ESC in rephrase menu = cancel (option 5)
      const result = handleRephraseChoice("5", agent);
      const historyManager = ChatHistoryManager.getInstance();
      historyManager.saveContext(agent.getSystemPrompt(), result.updatedChatHistory, agent.getSessionState());
      setChatHistory(result.updatedChatHistory);
      setShowRephraseMenu(false);
      setSelectedRephraseIndex(0);
      return;
    }
    if (isProcessing || isStreaming) {
      wasCancelled.current = true;
      agent.abortCurrentOperation();
      setIsProcessing(false);
      setIsStreaming(false);
      setTokenCount(0);
      setProcessingTime(0);
      processingStartTime.current = 0;
      return;
    }
    // Otherwise, just return to input (no-op)
  };

  const handleSpecialKey = (key: Key): boolean => {
    // Don't handle input if confirmation dialog is active
    if (isConfirmationActive) {
      return true; // Prevent default handling
    }

    // Handle shift+tab to toggle auto-edit mode
    if (key.shift && key.tab) {
      const newAutoEditState = !autoEditEnabled;
      setAutoEditEnabled(newAutoEditState);

      const confirmationService = ConfirmationService.getInstance();
      if (newAutoEditState) {
        // Enable auto-edit: set all operations to be accepted
        confirmationService.setSessionFlag("allOperations", true);
      } else {
        // Disable auto-edit: reset session flags
        confirmationService.resetSession();
      }
      return true; // Handled
    }

    // Handle command suggestions navigation
    if (showCommandSuggestions) {
      const filteredSuggestions = filterCommandSuggestions(
        commandSuggestions,
        input
      );

      if (filteredSuggestions.length === 0) {
        setShowCommandSuggestions(false);
        setSelectedCommandIndex(0);
        return false; // Continue processing
      } else {
        if (key.upArrow) {
          setSelectedCommandIndex((prev) =>
            prev === 0 ? filteredSuggestions.length - 1 : prev - 1
          );
          return true;
        }
        if (key.downArrow) {
          setSelectedCommandIndex(
            (prev) => (prev + 1) % filteredSuggestions.length
          );
          return true;
        }
        if (key.tab || key.return) {
          // Check if Enter was pressed and input exactly matches a command
          // If so, allow it to submit instead of forcing autocomplete selection
          if (key.return) {
            const exactMatch = commandSuggestions.some(
              (cmd) => cmd.command === input.trim()
            );
            if (exactMatch) {
              // Let Enter submit the command
              setShowCommandSuggestions(false);
              setSelectedCommandIndex(0);
              return false; // Allow normal Enter handling to proceed
            }
          }

          // Otherwise, autocomplete with selected suggestion
          const safeIndex = Math.min(
            selectedCommandIndex,
            filteredSuggestions.length - 1
          );
          const selectedCommand = filteredSuggestions[safeIndex];
          const newInput = selectedCommand.command + " ";
          setInput(newInput);
          setCursorPosition(newInput.length);
          setShowCommandSuggestions(false);
          setSelectedCommandIndex(0);
          return true;
        }
      }
    }

    // Handle model selection navigation
    if (showModelSelection) {
      if (key.upArrow) {
        setSelectedModelIndex((prev) =>
          prev === 0 ? availableModels.length - 1 : prev - 1
        );
        return true;
      }
      if (key.downArrow) {
        setSelectedModelIndex((prev) => (prev + 1) % availableModels.length);
        return true;
      }
      if (key.tab || key.return) {
        const selectedModel = availableModels[selectedModelIndex];
        agent.setModel(selectedModel.model);
        updateCurrentModel(selectedModel.model);
        const confirmEntry: ChatEntry = {
          type: "assistant",
          content: `✓ Switched to model: ${selectedModel.model}`,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, confirmEntry]);
        setShowModelSelection(false);
        setSelectedModelIndex(0);
        return true;
      }
    }

    // Handle rephrase menu navigation
    if (showRephraseMenu) {
      const numOptions = 5;

      if (key.upArrow) {
        setSelectedRephraseIndex((prev) =>
          prev === 0 ? numOptions - 1 : prev - 1
        );
        return true;
      }
      if (key.downArrow) {
        setSelectedRephraseIndex((prev) => (prev + 1) % numOptions);
        return true;
      }
      if (key.tab || key.return) {
        const choice = String(selectedRephraseIndex + 1);
        const result = handleRephraseChoice(choice, agent);
        const historyManager = ChatHistoryManager.getInstance();
        historyManager.saveContext(agent.getSystemPrompt(), result.updatedChatHistory, agent.getSessionState());
        setChatHistory(result.updatedChatHistory);
        setShowRephraseMenu(false);
        setSelectedRephraseIndex(0);

        // If preFillPrompt exists (options 3 and 4), set input
        if (result.preFillPrompt) {
          setInput(result.preFillPrompt);
          setCursorPosition(result.preFillPrompt.length);
        }
        return true;
      }
    }

    return false; // Let default handling proceed
  };

  const handleInputSubmit = async (userInput: string) => {
    if (userInput === "exit" || userInput === "quit") {
      process.exit(0);
      return;
    }

    // Check for pending context edit confirmation (stored in agent, survives re-renders)
    const pendingEdit = agent.getPendingContextEditSession();
    if (pendingEdit) {
      const trimmed = userInput.trim().toLowerCase();
      const { tmpJsonPath, contextFilePath } = pendingEdit;

      if (trimmed === "y" || trimmed === "yes") {
        // User confirmed - replace context
        const fs = await import("fs");

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

        // Sync UI with reloaded context
        setChatHistory(agent.getChatHistory());

        // Clean up temp file
        try {
          fs.unlinkSync(tmpJsonPath);
        } catch (err) {
          // Ignore cleanup errors
        }
      } else {
        // User cancelled or said no
        const fs = await import("fs");

        // Clean up temp file
        try {
          fs.unlinkSync(tmpJsonPath);
        } catch (err) {
          // Ignore cleanup errors
        }
      }

      // Clear pending state
      agent.clearPendingContextEditSession();
      clearInput();
      return;
    }

    if (userInput.trim()) {
      wasCancelled.current = false;
      const directCommandResult = await handleDirectCommand(userInput);
      if (!directCommandResult) {
        await processUserMessage(userInput);
      }
    }
  };

  const handleInputChange = (newInput: string) => {
    // Update command suggestions based on input
    if (newInput.startsWith("/")) {
      setShowCommandSuggestions(true);
      setSelectedCommandIndex(0);
    } else {
      setShowCommandSuggestions(false);
      setSelectedCommandIndex(0);
    }
  };

  const {
    input,
    cursorPosition,
    setInput,
    setCursorPosition,
    clearInput,
    resetHistory,
    handleInput,
  } = useEnhancedInput({
    onSubmit: handleInputSubmit,
    onSpecialKey: handleSpecialKey,
    onEscape: handleEscape,
    onCtrlC: handleEscape,
    disabled: isConfirmationActive,
  });

  // Hook up the actual input handling
  useInput((inputChar: string, key: Key) => {
    handleInput(inputChar, key);
  });

  // Additional input handler specifically for abort operations (always active)
  useInput((inputChar: string, key: Key) => {
    // Handle ESC and Ctrl+C during streaming/processing (bypass normal input handling)
    if ((isProcessing || isStreaming) && (key.escape || (key.ctrl && inputChar === "c") || inputChar === "\x03")) {
      handleEscape();
    }
  });

  // Additional input handler for rephrase menu number keys
  useInput((inputChar: string, key: Key) => {
    if (showRephraseMenu && inputChar >= "1" && inputChar <= "5") {
      const choice = inputChar;
      const result = handleRephraseChoice(choice, agent);
      const historyManager = ChatHistoryManager.getInstance();
      historyManager.saveContext(agent.getSystemPrompt(), result.updatedChatHistory, agent.getSessionState());
      setChatHistory(result.updatedChatHistory);
      setShowRephraseMenu(false);
      setSelectedRephraseIndex(0);

      // If preFillPrompt exists (options 3 and 4), set input
      if (result.preFillPrompt) {
        setInput(result.preFillPrompt);
        setCursorPosition(result.preFillPrompt.length);
      }
    }
  });

  // Update command suggestions when input changes
  useEffect(() => {
    handleInputChange(input);
  }, [input]);

  const commandSuggestions: CommandSuggestion[] = [
    { command: "/?", description: "Introspect help (alias for /introspect)" },
    { command: "/? all", description: "Show tools, env, and context" },
    { command: "/? commands", description: "Show available slash commands" },
    { command: "/? context", description: "Show context/token usage" },
    { command: "/? def:", description: "Show variable definition with birth children tree" },
    { command: "/? defs", description: "Show all prompt variable definitions" },
    { command: "/? env", description: "Show environment variables" },
    { command: "/? render:", description: "Render a specific prompt variable" },
    { command: "/? tool:", description: "Show details about a specific tool" },
    { command: "/? tools", description: "Show all available tools" },
    { command: "/? var:", description: "Show details about a specific prompt variable" },
    { command: "/? vars", description: "Show all set prompt variables" },
    { command: "/clear", description: "Clear chat history" },
    { command: "/commit-and-push", description: "AI commit & push to remote" },
    { command: "/compact", description: "Reduce context size (keep last 20 messages)" },
    { command: "/context", description: "Show context usage info" },
    { command: "/context edit", description: "Edit context JSON" },
    { command: "/context reload", description: "Reload context from file" },
    { command: "/context view", description: "View context in pager" },
    { command: "/exit", description: "Exit the application" },
    { command: "/help", description: "Show help information" },
    { command: "/ink", description: "Switch to Ink UI mode (restart required)" },
    { command: "/introspect", description: "Introspect help" },
    { command: "/introspect all", description: "Show tools, env, and context" },
    { command: "/introspect commands", description: "Show available slash commands" },
    { command: "/introspect context", description: "Show context/token usage" },
    { command: "/introspect def:", description: "Show variable definition with birth children tree" },
    { command: "/introspect defs", description: "Show all prompt variable definitions" },
    { command: "/introspect env", description: "Show environment variables" },
    { command: "/introspect render:", description: "Render a specific prompt variable" },
    { command: "/introspect tool:", description: "Show details about a specific tool" },
    { command: "/introspect tools", description: "Show all available tools" },
    { command: "/introspect var:", description: "Show details about a specific prompt variable" },
    { command: "/introspect vars", description: "Show all set prompt variables" },
    { command: "/models", description: "Switch LLM Model" },
    { command: "/mood", description: "Set mood text (e.g., /mood focused green)" },
    { command: "/no-ink", description: "Switch to plain console mode (restart required)" },
    { command: "/persona", description: "Set persona text (e.g., /persona debugging red)" },
    { command: "/rephrase", description: "Request rephrasing of last response" },
    { command: "/restart", description: "Restart the application (exit code 51)" },
    { command: "/system rephrase", description: "Rephrase as system message" },
  ];

  // Load models from configuration with fallback to defaults
  const availableModels: ModelOption[] = useMemo(() => {
    return loadModelConfig(); // Return directly, interface already matches
  }, []);

  const handleDirectCommand = async (input: string): Promise<boolean> => {
    const trimmedInput = input.trim();

    // Handle !<command> - execute and add to context, but don't send to LLM
    if (trimmedInput.startsWith("!")) {
      const command = trimmedInput.substring(1).trim();
      if (command) {
        // Add user message to show the command in chat history
        const userEntry: ChatEntry = {
          type: "user",
          content: trimmedInput,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, userEntry]);

        // Execute the command and add result to chat history
        const result = await agent.executeCommand(command, true); // skip confirmation

        const commandEntry: ChatEntry = {
          type: "tool_result",
          content: result.success
            ? result.output || "Command completed"
            : result.error || "Command failed",
          timestamp: new Date(),
          toolCall: {
            id: `user_execute_${Date.now()}`,
            type: "function",
            function: {
              name: "execute",
              arguments: JSON.stringify({ command: command }),
            },
          },
          toolResult: result,
        };
        setChatHistory((prev) => [...prev, commandEntry]);

        // Return true - command executed, don't send to LLM as prompt
        return true;
      }
      return true; // Empty command after !
    }

    if (trimmedInput === "/clear") {
      try {
        // Set processing to true temporarily to prevent sync during clear
        setIsProcessing(true);

        // Clear agent's internal context (messages array + chat history)
        await agent.clearCache();

        // Reset UI chat history to match cleared agent state
        setChatHistory(agent.getChatHistory());

        // Reset total token usage
        setTotalTokenUsage(0);

        // Reset processing states
        setIsProcessing(false);
        setIsStreaming(false);
        setTokenCount(0);
        setProcessingTime(0);
        processingStartTime.current = 0;

        // Reset confirmation service session flags
        const confirmationService = ConfirmationService.getInstance();
        confirmationService.resetSession();

        clearInput();
        resetHistory();
        return true;
      } catch (error) {
        console.error("Error during /clear command:", error);
        setIsProcessing(false);
        setIsStreaming(false);
        return true;
      }
    }

    if (trimmedInput === "/compact") {
      try {
        const removedCount = agent.compactContext(20);

        const message = removedCount > 0
          ? `Context compacted: removed ${removedCount} messages, kept last 20 messages`
          : `Context already compact`;

        // Sync React state with agent's compacted history (which already includes the compaction note)
        setChatHistory(agent.getChatHistory());

        // Save compacted context to disk
        const historyManager = ChatHistoryManager.getInstance();
        const sessionState = agent.getSessionState();
        historyManager.saveContext(agent.getSystemPrompt(), agent.getChatHistory(), sessionState);

        clearInput();
        return true;
      } catch (error) {
        const errorMessage = `ERROR: Failed to compact context: ${error instanceof Error ? error.message : String(error)}`;
        console.error(errorMessage);
        const errorEntry: ChatEntry = {
          type: "system",
          content: errorMessage,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, errorEntry]);
        clearInput();
        return true;
      }
    }

    if (trimmedInput.startsWith("/introspect") || trimmedInput.startsWith("/?")) {
      // Add user message to show the command in chat history
      const userEntry: ChatEntry = {
        type: "user",
        content: trimmedInput,
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, userEntry]);

      const parts = trimmedInput.split(" ");
      const target = parts[1] || "help";

      const toolResult = await agent["introspect"].introspect(target);
      const introspectEntry: ChatEntry = {
        type: "assistant",
        content: toolResult.success ? toolResult.output! : toolResult.error!,
        timestamp: new Date(),
        preserveFormatting: true,
      };
      setChatHistory((prev) => [...prev, introspectEntry]);
      clearInput();
      return true;
    }

    if (trimmedInput === "/help") {
      const helpEntry: ChatEntry = {
        type: "assistant",
        content: HELP_TEXT,
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, helpEntry]);
      clearInput();
      return true;
    }

    if (trimmedInput === "/restart") {
      // Call the restart tool which exits with code 51
      await agent["restartTool"].restart();
      return true; // This line won't be reached but TypeScript needs it
    }

    if (trimmedInput === "/ink") {
      // Already in ink mode
      clearInput();
      return true;
    }

    if (trimmedInput === "/no-ink") {
      // Switch to plain console mode
      const switchEntry: ChatEntry = {
        type: "assistant",
        content: "Switching to plain console mode...",
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, switchEntry]);

      // Exit with code 53 - wrapper will add --no-ink and restart
      process.exit(53);
      return true;
    }

    if (trimmedInput === "/exit") {
      process.exit(0);
      return true;
    }

    if (trimmedInput === "/models") {
      setShowModelSelection(true);
      setSelectedModelIndex(0);
      clearInput();
      return true;
    }

    if (trimmedInput.startsWith("/models ")) {
      const modelArg = trimmedInput.split(" ")[1];
      const modelNames = availableModels.map((m) => m.model);

      if (modelNames.includes(modelArg)) {
        agent.setModel(modelArg);
        updateCurrentModel(modelArg); // Update project current model
        const confirmEntry: ChatEntry = {
          type: "assistant",
          content: `✓ Switched to model: ${modelArg}`,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, confirmEntry]);
      } else {
        const errorEntry: ChatEntry = {
          type: "assistant",
          content: `Invalid model: ${modelArg}

Available models: ${modelNames.join(", ")}`,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, errorEntry]);
      }

      clearInput();
      return true;
    }

    if (trimmedInput.startsWith("/context")) {
      const parts = trimmedInput.split(" ");
      const subcommand = parts[1];

      if (subcommand === "view") {
        // View context as markdown in pager
        try {
          const { spawn } = await import("child_process");
          const fs = await import("fs");
          const path = await import("path");

          // Get context file path
          const historyManager = ChatHistoryManager.getInstance();
          const contextFilePath = historyManager.getContextFilePath();

          // Create temp files
          const tmpDir = path.dirname(contextFilePath);
          const tmpMdPath = `${contextFilePath}.md.tmp`;

          // Convert context to markdown
          const markdown = await agent.convertContextToMarkdown();
          fs.writeFileSync(tmpMdPath, markdown, "utf-8");

          // Get viewer command and check if we need to suspend Ink UI
          const settings = await import("../utils/settings-manager.js");
          const settingsManager = settings.getSettingsManager();
          const viewerCommand = settingsManager.getContextViewHelper();

          // Determine if we're in text mode (need to suspend Ink) or GUI mode (don't suspend)
          const inkInstance = (global as any).inkInstance;
          const needsSuspend = inkInstance && !settingsManager.isGuiAvailable();

          if (needsSuspend) {
            // Unmount Ink UI before spawning text-mode viewer
            inkInstance.unmount();
            inkInstance.waitUntilExit();
          }

          // Spawn viewer
          const viewerProcess = spawn(viewerCommand, [tmpMdPath], {
            stdio: "inherit",
            shell: true,
          });

          await new Promise<void>((resolve) => {
            viewerProcess.on("close", () => {
              // Clean up temp file
              try {
                fs.unlinkSync(tmpMdPath);
              } catch (err) {
                // Ignore cleanup errors
              }
              resolve();
            });
          });

          // Re-render Ink UI after external process exits (only if we suspended it)
          if (needsSuspend) {
            const React = await import("react");
            const { render } = await import("ink");
            const { default: ChatInterface } = await import("../ui/components/chat-interface.js");

            // Clear screen
            process.stdout.write('\x1b[2J\x1b[0f');

            // Re-render with current state (don't reload from file)
            const newInstance = render(React.createElement(ChatInterface, {
              agent,
              initialMessage: undefined,
              fresh: true
            }));

            // Update global instance
            (global as any).inkInstance = newInstance;
          }

          clearInput();
          return true;
        } catch (error) {
          console.error("Error viewing context:", error);
          clearInput();
          return true;
        }
      } else if (subcommand === "edit") {
        // Edit context JSON in editor
        try {
          const { spawn } = await import("child_process");
          const fs = await import("fs");
          const path = await import("path");

          // Get context file path
          const historyManager = ChatHistoryManager.getInstance();
          const contextFilePath = historyManager.getContextFilePath();

          // If context file doesn't exist yet, save it first
          if (!fs.existsSync(contextFilePath)) {
            historyManager.saveContext(agent.getSystemPrompt(), agent.getChatHistory(), agent.getSessionState());
          }

          // Create temp copy
          const tmpJsonPath = `${contextFilePath}.tmp`;
          fs.copyFileSync(contextFilePath, tmpJsonPath);

          // Get editor command and check if we need to suspend Ink UI
          const settings = await import("../utils/settings-manager.js");
          const settingsManager = settings.getSettingsManager();
          const editorCommand = settingsManager.getContextEditHelper();

          // Determine if we're in text mode (need to suspend Ink) or GUI mode (don't suspend)
          const inkInstance = (global as any).inkInstance;
          const isInkMode = (global as any).isInkMode;
          const isGui = settingsManager.isGuiAvailable();
          const needsSuspend = isInkMode && inkInstance && !isGui;

          if (needsSuspend) {
            // Unmount Ink UI before spawning text-mode editor
            inkInstance.unmount();
            inkInstance.waitUntilExit();
          }

          // Terminal mode and GUI mode both use regular spawn
          if (needsSuspend) {
            // Terminal mode: Put stdin in cooked mode then use regular spawn
            if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
              process.stdin.setRawMode(false);
            }

            const editorProcess = spawn(editorCommand, [tmpJsonPath], {
              stdio: "inherit",
              shell: true,
            });

            await new Promise<void>((resolve) => {
              editorProcess.on("close", () => {
                // Restore raw mode for Ink
                if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
                  process.stdin.setRawMode(true);
                }
                resolve();
              });
            });
          } else {
            // GUI mode: Use regular spawn
            const editorProcess = spawn(editorCommand, [tmpJsonPath], {
              stdio: "inherit",
              shell: true,
            });

            await new Promise<void>((resolve) => {
              editorProcess.on("close", () => {
                resolve();
              });
            });
          }

          // Validate edited JSON BEFORE re-rendering
          let isValid = false;
          let validationError = "";
          try {
            const editedContent = fs.readFileSync(tmpJsonPath, "utf-8");
            JSON.parse(editedContent); // Will throw if invalid
            isValid = true;
          } catch (error) {
            validationError = error instanceof Error ? error.message : String(error);
          }

          if (!isValid) {
            // Re-render Ink UI first (only if we suspended it)
            if (needsSuspend) {
              const React = await import("react");
              const { render } = await import("ink");
              const { default: ChatInterface } = await import("../ui/components/chat-interface.js");

              process.stdout.write('\x1b[2J\x1b[0f');
              const newInstance = render(React.createElement(ChatInterface, {
                agent,
                initialMessage: undefined,
                fresh: true  // Don't reload from file
              }));
              (global as any).inkInstance = newInstance;
            }

            console.error("Edited context file contains invalid JSON:", validationError);

            // Clean up temp file
            try {
              fs.unlinkSync(tmpJsonPath);
            } catch (err) {
              // Ignore cleanup errors
            }

            clearInput();
            return true;
          }

          // Store pending edit info in agent (survives re-renders)
          agent.setPendingContextEditSession(tmpJsonPath, contextFilePath);

          // Add prompt to both agent history and React state BEFORE re-rendering
          const promptEntry: ChatEntry = {
            type: "system",
            content: "Editor closed. Replace context with edited version? (y/n)",
            timestamp: new Date(),
          };

          // Add to agent's history first
          const agentHistory = agent.getChatHistory();
          agent.setChatHistory([...agentHistory, promptEntry]);

          // Re-render Ink UI with updated history (only if we suspended it)
          if (needsSuspend) {
            const React = await import("react");
            const { render } = await import("ink");
            const { default: ChatInterface } = await import("../ui/components/chat-interface.js");

            // Clear screen
            process.stdout.write('\x1b[2J\x1b[0f');

            // Re-render - ChatInterface should not reload from file (we have pending state)
            const newInstance = render(React.createElement(ChatInterface, {
              agent,
              initialMessage: undefined,
              fresh: true  // Don't reload from file - use agent's current history
            }));

            // Update global instance
            (global as any).inkInstance = newInstance;
          } else {
            // GUI mode or no Ink - just update React state
            setChatHistory(agent.getChatHistory());
          }

          // Don't clean up temp file yet - we need it for confirmation
          // Cleanup will happen after user confirms or denies

          clearInput();
          return true;
        } catch (error) {
          console.error("Failed to edit context:", error);
          clearInput();
          return true;
        }
      } else if (subcommand === "reload") {
        // Reload context from context.json file immediately (no editor, no confirmation)
        try {
          const fs = await import("fs");

          // Get context file path
          const historyManager = ChatHistoryManager.getInstance();
          const contextFilePath = historyManager.getContextFilePath();

          // Verify context file exists
          if (!fs.existsSync(contextFilePath)) {
            const errorEntry: ChatEntry = {
              type: "assistant",
              content: `Error: Context file not found: ${contextFilePath}`,
              timestamp: new Date(),
            };
            setChatHistory((prev) => [...prev, errorEntry]);
            clearInput();
            return true;
          }

          // Reload context from file
          const { systemPrompt: reloadedSystemPrompt, chatHistory: reloadedHistory } = historyManager.loadContext();

          // Update agent's chat history
          agent.setChatHistory(reloadedHistory);

          // Update system prompt - regenerate if empty
          if (reloadedSystemPrompt && reloadedSystemPrompt.trim()) {
            agent.setSystemPrompt(reloadedSystemPrompt);
          } else {
            await agent.buildSystemMessage();
          }

          // Sync UI with reloaded context
          setChatHistory(agent.getChatHistory());

          // Add confirmation message
          const confirmEntry: ChatEntry = {
            type: "assistant",
            content: "Context reloaded from file",
            timestamp: new Date(),
          };
          setChatHistory((prev) => [...prev, confirmEntry]);

          clearInput();
          return true;
        } catch (error) {
          const errorEntry: ChatEntry = {
            type: "assistant",
            content: `Error reloading context: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: new Date(),
          };
          setChatHistory((prev) => [...prev, errorEntry]);
          clearInput();
          return true;
        }
      } else {
        // Default: show context usage info (redirect to /introspect context)
        // Add user message to show the command in chat history
        const userEntry: ChatEntry = {
          type: "user",
          content: trimmedInput,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, userEntry]);

        const toolResult = await agent["introspect"].introspect("context");
        const contextEntry: ChatEntry = {
          type: "assistant",
          content: toolResult.success ? toolResult.output! : toolResult.error!,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, contextEntry]);
        clearInput();
        return true;
      }
    }

    if (trimmedInput.startsWith("/persona")) {
      const parts = trimmedInput.split(" ");
      if (parts.length < 2) {
        const helpEntry: ChatEntry = {
          type: "assistant",
          content: "Usage: /persona <text> [color]\nExample: /persona debugging red",
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, helpEntry]);
        clearInput();
        return true;
      }

      const persona = parts[1];
      const color = parts[2];
      const result = await agent.setPersona(persona, color);

      const confirmEntry: ChatEntry = {
        type: "assistant",
        content: result.success
          ? `Persona set to: ${persona}${color ? ` (${color})` : ''}`
          : `Failed to set persona: ${result.error || 'Unknown error'}`,
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, confirmEntry]);

      // Save context with updated session state
      if (result.success) {
        const historyManager = ChatHistoryManager.getInstance();
        historyManager.saveContext(agent.getSystemPrompt(), agent.getChatHistory(), agent.getSessionState());
      }

      clearInput();
      return true;
    }

    if (trimmedInput.startsWith("/mood")) {
      const parts = trimmedInput.split(" ");
      if (parts.length < 2) {
        const helpEntry: ChatEntry = {
          type: "assistant",
          content: "Usage: /mood <text> [color]\nExample: /mood focused green",
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, helpEntry]);
        clearInput();
        return true;
      }

      const mood = parts[1];
      const color = parts[2];
      const result = await agent.setMood(mood, color);

      const confirmEntry: ChatEntry = {
        type: "assistant",
        content: result.success
          ? `Mood set to: ${mood}${color ? ` (${color})` : ''}`
          : `Failed to set mood: ${result.error || 'Unknown error'}`,
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, confirmEntry]);

      // Save context with updated session state
      if (result.success) {
        const historyManager = ChatHistoryManager.getInstance();
        historyManager.saveContext(agent.getSystemPrompt(), agent.getChatHistory(), agent.getSessionState());
      }

      clearInput();
      return true;
    }

    if (trimmedInput === "/commit-and-push") {
      const userEntry: ChatEntry = {
        type: "user",
        content: "/commit-and-push",
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, userEntry]);

      setIsProcessing(true);
      setIsStreaming(true);

      try {
        // First check if there are any changes at all
        const initialStatusResult = await agent.executeCommand(
          "git status --porcelain"
        );

        if (
          !initialStatusResult.success ||
          !initialStatusResult.output?.trim()
        ) {
          const noChangesEntry: ChatEntry = {
            type: "assistant",
            content: "No changes to commit. Working directory is clean.",
            timestamp: new Date(),
          };
          setChatHistory((prev) => [...prev, noChangesEntry]);
          setIsProcessing(false);
          setIsStreaming(false);
          setInput("");
          return true;
        }

        // Add all changes
        const addResult = await agent.executeCommand("git add .");

        if (!addResult.success) {
          const addErrorEntry: ChatEntry = {
            type: "assistant",
            content: `Failed to stage changes: ${
              addResult.error || "Unknown error"
            }`,
            timestamp: new Date(),
          };
          setChatHistory((prev) => [...prev, addErrorEntry]);
          setIsProcessing(false);
          setIsStreaming(false);
          setInput("");
          return true;
        }

        // Show that changes were staged
        const addEntry: ChatEntry = {
          type: "tool_result",
          content: "Changes staged successfully",
          timestamp: new Date(),
          toolCall: {
            id: `git_add_${Date.now()}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "git add ." }),
            },
          },
          toolResult: addResult,
        };
        setChatHistory((prev) => [...prev, addEntry]);

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

        let commitMessage = "";
        let streamingEntry: ChatEntry | null = null;

        for await (const chunk of agent.processUserMessageStream(
          commitPrompt
        )) {
          if (chunk.type === "content" && chunk.content) {
            if (!streamingEntry) {
              const newEntry = {
                type: "assistant" as const,
                content: `Generating commit message...\n\n${chunk.content}`,
                timestamp: new Date(),
                isStreaming: true,
              };
              setChatHistory((prev) => [...prev, newEntry]);
              streamingEntry = newEntry;
              commitMessage = chunk.content;
            } else {
              commitMessage += chunk.content;
              setChatHistory((prev) =>
                prev.map((entry, idx) =>
                  idx === prev.length - 1 && entry.isStreaming
                    ? {
                        ...entry,
                        content: `Generating commit message...\n\n${commitMessage}`,
                      }
                    : entry
                )
              );
            }
          } else if (chunk.type === "done") {
            if (streamingEntry) {
              setChatHistory((prev) =>
                prev.map((entry) =>
                  entry.isStreaming
                    ? {
                        ...entry,
                        content: `Generated commit message: "${commitMessage.trim()}"`,
                        isStreaming: false,
                      }
                    : entry
                )
              );
            }
            break;
          }
        }

        // Execute the commit
        const cleanCommitMessage = commitMessage
          .trim()
          .replace(/^["']|["']$/g, "");
        const commitCommand = `git commit -m "${cleanCommitMessage}"`;
        const commitResult = await agent.executeCommand(commitCommand);

        const commitEntry: ChatEntry = {
          type: "tool_result",
          content: commitResult.success
            ? commitResult.output || "Commit successful"
            : commitResult.error || "Commit failed",
          timestamp: new Date(),
          toolCall: {
            id: `git_commit_${Date.now()}`,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: commitCommand }),
            },
          },
          toolResult: commitResult,
        };
        setChatHistory((prev) => [...prev, commitEntry]);

        // If commit was successful, push to remote
        if (commitResult.success) {
          // First try regular push, if it fails try with upstream setup
          let pushResult = await agent.executeCommand("git push");
          let pushCommand = "git push";

          if (
            !pushResult.success &&
            pushResult.error?.includes("no upstream branch")
          ) {
            pushCommand = "git push -u origin HEAD";
            pushResult = await agent.executeCommand(pushCommand);
          }

          const pushEntry: ChatEntry = {
            type: "tool_result",
            content: pushResult.success
              ? pushResult.output || "Push successful"
              : pushResult.error || "Push failed",
            timestamp: new Date(),
            toolCall: {
              id: `git_push_${Date.now()}`,
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({ command: pushCommand }),
              },
            },
            toolResult: pushResult,
          };
          setChatHistory((prev) => [...prev, pushEntry]);
        }
      } catch (error: any) {
        const errorEntry: ChatEntry = {
          type: "assistant",
          content: `Error during commit and push: ${error.message}`,
          timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, errorEntry]);
      }

      setIsProcessing(false);
      setIsStreaming(false);
      clearInput();
      return true;
    }

    return false;
  };

  const processUserMessage = async (userInput: string) => {
    setIsProcessing(true);
    clearInput();

    try {
      setIsStreaming(true);
      let streamingEntry: ChatEntry | null = null;
      let userMessageAdded = false; // Track if we've added the user message

      for await (const chunk of agent.processUserMessageStream(userInput)) {
        // Check if user cancelled - stop immediately
        if (wasCancelled.current) {
          setIsProcessing(false);
          setIsStreaming(false);
          return;
        }

        switch (chunk.type) {
          case "user_message":
            // Add user message to UI immediately when agent yields it
            // Only add if not already in history (prevents duplicates)
            if (chunk.userEntry && !userMessageAdded) {
              setChatHistory((prev) => {
                // Check if this exact message is already in history
                const alreadyExists = prev.some(entry =>
                  entry.type === "user" &&
                  entry.content === chunk.userEntry!.content
                );
                if (!alreadyExists) {
                  userMessageAdded = true;
                  return [...prev, chunk.userEntry!];
                }
                return prev;
              });
            }
            break;

          case "content":
            if (chunk.content) {
              if (!streamingEntry) {
                const newStreamingEntry = {
                  type: "assistant" as const,
                  content: chunk.content,
                  timestamp: new Date(),
                  isStreaming: true,
                };
                setChatHistory((prev) => [...prev, newStreamingEntry]);
                streamingEntry = newStreamingEntry;
              } else {
                setChatHistory((prev) =>
                  prev.map((entry, idx) =>
                    idx === prev.length - 1 && entry.isStreaming
                      ? { ...entry, content: (entry.content || "") + chunk.content }
                      : entry
                  )
                );
              }
            }
            break;

          case "token_count":
            if (chunk.tokenCount !== undefined) {
              currentTokenCount.current = chunk.tokenCount;
              setTokenCount(chunk.tokenCount);
            }
            break;

          case "tool_calls":
            if (chunk.tool_calls) {
              // Stop streaming for the current assistant message
              setChatHistory((prev) =>
                prev.map((entry) =>
                  entry.isStreaming
                    ? {
                        ...entry,
                        isStreaming: false,
                        tool_calls: chunk.tool_calls,
                      }
                    : entry
                )
              );
              streamingEntry = null;

              // Add individual tool call entries to show tools are being executed
              chunk.tool_calls.forEach((toolCall) => {
                const toolCallEntry: ChatEntry = {
                  type: "tool_call",
                  content: "Executing...",
                  timestamp: new Date(),
                  toolCall: toolCall,
                };
                setChatHistory((prev) => [...prev, toolCallEntry]);
              });
            }
            break;

          case "tool_result":
            if (chunk.toolCall && chunk.toolResult) {
              setChatHistory((prev) => {
                const updated = prev.map((entry): ChatEntry => {
                  if (entry.isStreaming) {
                    return { ...entry, isStreaming: false };
                  }
                  // Update the existing tool_call entry with the result
                  if (
                    entry.type === "tool_call" &&
                    entry.toolCall?.id === chunk.toolCall?.id
                  ) {
                    return {
                      ...entry,
                      type: "tool_result" as const,
                      toolCall: chunk.toolCall, // Use the new toolCall from chunk with complete arguments
                      content: chunk.toolResult.success
                        ? chunk.toolResult.output || "Success"
                        : chunk.toolResult.error || "Error occurred",
                      toolResult: chunk.toolResult,
                    };
                  }
                  return entry;
                });

                // Add any system messages that came with this tool result (from hooks)
                if (chunk.systemMessages && chunk.systemMessages.length > 0) {
                  return [...updated, ...chunk.systemMessages];
                }
                return updated;
              });
              streamingEntry = null;
            }
            break;

          case "done":
            if (streamingEntry) {
              setChatHistory((prev) =>
                prev.map((entry) =>
                  entry.isStreaming ? { ...entry, isStreaming: false } : entry
                )
              );
            }
            // Note: System messages are now added immediately with tool_result chunks
            // Only sync system messages that weren't already added during tool execution
            const agentHistory = agent.getChatHistory();
            const agentSystemMessages = agentHistory.filter(e => e.type === "system");

            setChatHistory((prev) => {
              // If agent has exactly 1 system message, ensure UI has only that one
              // This handles system message regeneration (e.g., when model doesn't support tools)
              if (agentSystemMessages.length === 1) {
                const firstSystemIndex = prev.findIndex(e => e.type === "system");
                if (firstSystemIndex >= 0) {
                  // Replace first system message with agent's version, remove any others
                  const nonSystemEntries = prev.filter(e => e.type !== "system");
                  return [
                    ...prev.slice(0, firstSystemIndex),
                    agentSystemMessages[0],
                    ...nonSystemEntries.slice(firstSystemIndex)
                  ];
                }
              }

              // For other cases (multiple system messages from hooks, etc.), use original logic
              // Find system messages from agent that UI doesn't have
              const newSystemMessages = agentSystemMessages.filter(agentMsg =>
                !prev.some(uiMsg =>
                  uiMsg.type === "system" &&
                  uiMsg.content === agentMsg.content
                )
              );

              // Only add if there are truly new messages (e.g., from startup hooks)
              if (newSystemMessages.length > 0) {
                return [...prev, ...newSystemMessages];
              }
              return prev;
            });

            setIsStreaming(false);
            // Use the tokenCount ref that was set during streaming
            setTotalTokenUsage(prev => prev + currentTokenCount.current);
            currentTokenCount.current = 0; // Reset for next request
            break;
        }
      }
    } catch (error: any) {
      const errorEntry: ChatEntry = {
        type: "assistant",
        content: `Error: ${error.message}`,
        timestamp: new Date(),
      };
      setChatHistory((prev) => [...prev, errorEntry]);
      setIsStreaming(false);
    }

    // Check if this was a rephrase command and show menu
    const rephraseState = agent.getRephraseState();
    if (rephraseState) {
      setShowRephraseMenu(true);
      setSelectedRephraseIndex(0);
    }

    setIsProcessing(false);
    processingStartTime.current = 0;
  };


  return {
    input,
    cursorPosition,
    showCommandSuggestions,
    selectedCommandIndex,
    showModelSelection,
    selectedModelIndex,
    showRephraseMenu,
    selectedRephraseIndex,
    commandSuggestions,
    availableModels,
    agent,
    autoEditEnabled,
  };
}
