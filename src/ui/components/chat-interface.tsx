// Optimization to reduce flickering in Ink TUI

import React, { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { LLMAgent, ChatEntry } from "../../agent/llm-agent.js";
import { useInputHandler } from "../../hooks/use-input-handler.js";
import { LoadingSpinner } from "./loading-spinner.js";
import { CommandSuggestions } from "./command-suggestions.js";
import { ModelSelection } from "./model-selection.js";
import { RephraseMenu } from "./rephrase-menu.js";
import { ChatHistory } from "./chat-history.js";
import { ChatInput } from "./chat-input.js";
import { MCPStatus } from "./mcp-status.js";
import { ContextStatus } from "./context-status.js";
import { PersonaStatus } from "./persona-status.js";
import { MoodStatus } from "./mood-status.js";
import { ActiveTaskStatus } from "./active-task-status.js";
import { BackendStatus } from "./backend-status.js";
import ConfirmationDialog from "./confirmation-dialog.js";
import {
  ConfirmationService,
  ConfirmationOptions,
} from "../../utils/confirmation-service.js";
import ApiKeyInput from "./api-key-input.js";
import cfonts from "cfonts";
import { ChatHistoryManager } from "../../utils/chat-history-manager.js";

interface ChatInterfaceProps {
  agent?: LLMAgent;
  initialMessage?: string;
  fresh?: boolean;
}

// Main chat component that handles input when agent is available
function ChatInterfaceWithAgent({
  agent,
  initialMessage,
  fresh,
}: {
  agent: LLMAgent;
  initialMessage?: string;
  fresh?: boolean;
}) {
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingTime, setProcessingTime] = useState(0);
  const [tokenCount, setTokenCount] = useState(0);
  const [totalTokenUsage, setTotalTokenUsage] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const [confirmationOptions, setConfirmationOptions] =
    useState<ConfirmationOptions | null>(null);
  const scrollRef = useRef<any>(null);
  const processingStartTime = useRef<number>(0);

  const confirmationService = ConfirmationService.getInstance();

  const {
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
    autoEditEnabled,
  } = useInputHandler({
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
    isConfirmationActive: !!confirmationOptions,
    totalTokenUsage,
  });

  useEffect(() => {
    const initializeHistory = async () => {
      // Add top padding
      console.log("    ");

      // Generate logo with margin to match Ink paddingX={2}
      const logoOutput = cfonts.render("zds ai cli", {
        font: "simple3d",
        align: "left",
        colors: ["#e16f0b", "#6f2a92", "#336ca3", "#336ca3", "#336ca3"],
        space: true,
        maxLength: "0",
        gradient: ["#e16f0b", "#6f2a92", "#336ca3", "#336ca3", "#336ca3"],
        independentGradient: false,
        transitionGradient: true,
        env: "node",
      });

      // Add horizontal margin (2 spaces) to match Ink paddingX={2}
      const logoLines = (logoOutput as any).string.split("\n");
      logoLines.forEach((line: string) => {
        if (line.trim()) {
          console.log(" " + line); // Add 2 spaces for horizontal margin
        } else {
          console.log(line); // Keep empty lines as-is
        }
      });

      console.log(" "); // Spacing after logo

      // Load chat history from file (unless fresh session is requested)
      const historyManager = ChatHistoryManager.getInstance();
      if (!fresh) {
        const { systemPrompt, chatHistory: loadedHistory, sessionState } = historyManager.loadContext();
        setChatHistory(loadedHistory);
        await agent.loadInitialHistory(loadedHistory, systemPrompt);
        // Sync back from agent in case loadInitialHistory modified the history
        setChatHistory(agent.getChatHistory());
        // Initialize token count from loaded history
        setTotalTokenUsage(agent.getCurrentTokenCount());
        // Restore session state (persona, mood, task, cwd)
        if (sessionState) {
          await agent.restoreSessionState(sessionState);
        }
      } else {
        // Clear existing history file for fresh session
        historyManager.clearHistory();
        // Reset confirmation service session flags
        confirmationService.resetSession();
      }

      // Initialize UI chatHistory with agent's complete history (including system prompts)
      // This ensures system prompts are preserved when syncing back
      // Normalize timestamps to ensure they're Date objects
      const agentHistory = agent.getChatHistory().map(entry => ({
        ...entry,
        timestamp: entry.timestamp instanceof Date ? entry.timestamp : new Date(entry.timestamp)
      }));
      setChatHistory(agentHistory);

      // Save initial context after initialization completes
      // This ensures context file exists even on fresh sessions before first message
      historyManager.saveContext(agent.getSystemPrompt(), agent.getChatHistory(), agent.getSessionState());
      historyManager.saveMessages(agent.getMessages());
    };

    initializeHistory();
  }, []);
   // Optimize streaming updates to reduce flickering

  // Sync chatHistory back to agent whenever it changes (critical for saving on Ctrl+C)
  // But don't sync during processing/streaming - agent manages its own history during that time
  useEffect(() => {
    if (chatHistory.length > 0 && !isProcessing && !isStreaming) {
      agent.setChatHistory(chatHistory);
    }
  }, [chatHistory, agent, isProcessing, isStreaming]);

  // Process initial message if provided (streaming for faster feedback)
  useEffect(() => {
    if (initialMessage && agent) {
      const processInitialMessage = async () => {
        setIsProcessing(true);
        setIsStreaming(true);

        try {
          let streamingEntry: ChatEntry | null = null;
          let userMessageAdded = false; // Track if we've added the user message
          for await (const chunk of agent.processUserMessageStream(initialMessage)) {
            switch (chunk.type) {
              case "user_message":
                // Add user message to UI immediately when agent yields it
                // Only add if not already in history (prevents duplicates)
                if (chunk.userEntry && !userMessageAdded) {
                  setChatHistory((prev) => {
                    // Check if this exact message is already in history
                    // For content comparison, stringify to handle both string and array content
                    const alreadyExists = prev.some(entry =>
                      entry.type === "user" &&
                      JSON.stringify(entry.content) === JSON.stringify(chunk.userEntry!.content)
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
                      prev.map((entry, idx) => {
                        if (idx === prev.length - 1 && entry.isStreaming) {
                          // Streaming responses are always text
                          const existingContent = typeof entry.content === 'string' ? entry.content : '';
                          return { ...entry, content: existingContent + chunk.content };
                        }
                        return entry;
                      })
                    );
                  }
                }
                break;
              case "token_count":
                if (chunk.tokenCount !== undefined) {
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
                  setChatHistory((prev) =>
                    prev.map((entry) => {
                      if (entry.isStreaming) {
                        return { ...entry, isStreaming: false };
                      }
                      if (
                        entry.type === "tool_call" &&
                        entry.toolCall?.id === chunk.toolCall?.id
                      ) {
                        return {
                          ...entry,
                          type: "tool_result",
                          content: chunk.toolResult.success
                            ? (chunk.toolResult.output?.trim() || "Success")
                            : (chunk.toolResult.error?.trim() || "Error occurred"),
                          toolResult: chunk.toolResult,
                        };
                      }
                      return entry;
                    })
                  );

                  // Add any system messages that were generated during tool execution
                  // This displays chdir notifications immediately, not at the end
                  if (chunk.systemMessages && chunk.systemMessages.length > 0) {
                    setChatHistory((prev) => [
                      ...prev,
                      ...chunk.systemMessages!.map(msg => ({
                        ...msg,
                        timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp)
                      }))
                    ]);
                  }

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
                // Sync ONLY system messages from agent that UI doesn't have
                // This captures hook messages without duplicating user/assistant messages
                const agentHistory = agent.getChatHistory();
                const agentSystemMessages = agentHistory.filter(e => e.type === "system");

                setChatHistory((prev) => {
                  // Find system messages from agent that UI doesn't have
                  const newSystemMessages = agentSystemMessages.filter(agentMsg =>
                    !prev.some(uiMsg =>
                      uiMsg.type === "system" &&
                      uiMsg.content === agentMsg.content
                    )
                  );

                  if (newSystemMessages.length > 0) {
                    // Ensure timestamps are Date objects before adding to UI state
                    const normalizedMessages = newSystemMessages.map(msg => ({
                      ...msg,
                      timestamp: msg.timestamp instanceof Date ? msg.timestamp : new Date(msg.timestamp)
                    }));
                    return [...prev, ...normalizedMessages];
                  }
                  return prev;
                });

                setIsStreaming(false);
                setTotalTokenUsage(prev => prev + tokenCount);
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

        setIsProcessing(false);
        processingStartTime.current = 0;
      };

      processInitialMessage();
    }
  }, [initialMessage, agent]);

  useEffect(() => {
    const handleConfirmationRequest = (options: ConfirmationOptions) => {
      setConfirmationOptions(options);
    };

    confirmationService.on("confirmation-requested", handleConfirmationRequest);

    return () => {
      confirmationService.off(
        "confirmation-requested",
        handleConfirmationRequest
      );
    };
  }, [confirmationService]);

  useEffect(() => {
    if (!isProcessing && !isStreaming) {
      setProcessingTime(0);
      return;
    }

    if (processingStartTime.current === 0) {
      processingStartTime.current = Date.now();
    }

    // Reduce update frequency to every 2 seconds to minimize re-renders
    const interval = setInterval(() => {
      setProcessingTime(
        Math.floor((Date.now() - processingStartTime.current) / 1000)
      );
    }, 2000);

    return () => clearInterval(interval);
  }, [isProcessing, isStreaming]);

  // Save chat history and session state to file when it changes (but not during streaming/processing)
  useEffect(() => {
    if (chatHistory.length > 0 && !isProcessing && !isStreaming) {
      const historyManager = ChatHistoryManager.getInstance();
      // Filter out streaming entries before saving
      const historyToSave = chatHistory.filter(entry => !entry.isStreaming);
      // Get session state (persona, mood, task, cwd)
      const sessionState = agent.getSessionState();
      // Save context (systemPrompt + chatHistory + sessionState)
      historyManager.saveContext(agent.getSystemPrompt(), historyToSave, sessionState);
      // Also save the raw messages
      const messages = agent.getMessages();
      historyManager.saveMessages(messages);
    }
  }, [chatHistory, isProcessing, isStreaming]);

  // CRITICAL: Always save context on unmount, regardless of processing state
  // This ensures context is saved when user exits (^D, Ctrl+C, etc.)
  useEffect(() => {
    return () => {
      // Cleanup function runs on unmount
      if (chatHistory.length > 0) {
        try {
          const historyManager = ChatHistoryManager.getInstance();
          // Filter out streaming entries before saving
          const historyToSave = chatHistory.filter(entry => !entry.isStreaming);
          // Get session state (persona, mood, task, cwd)
          const sessionState = agent.getSessionState();
          // Save context (systemPrompt + chatHistory + sessionState)
          historyManager.saveContext(agent.getSystemPrompt(), historyToSave, sessionState);
          // Also save the raw messages
          const messages = agent.getMessages();
          historyManager.saveMessages(messages);
        } catch (error) {
          // Log error but don't throw during cleanup
          console.error("Failed to save context on unmount:", error);
        }
      }
    };
  }, [chatHistory, agent]); // Dependencies: re-create cleanup when chatHistory or agent changes

  const handleConfirmation = (dontAskAgain?: boolean) => {
    confirmationService.confirmOperation(true, dontAskAgain);
    setConfirmationOptions(null);
  };

  const handleRejection = (feedback?: string) => {
    confirmationService.rejectOperation(feedback);
    setConfirmationOptions(null);

    // Reset processing states when operation is cancelled
    setIsProcessing(false);
    setIsStreaming(false);
    setTokenCount(0);
    setProcessingTime(0);
    processingStartTime.current = 0;
  };

  return (
    <Box flexDirection="column" paddingX={0}>
      {/* Show tips only when no chat history and no confirmation dialog */}
      {chatHistory.length === 0 && !confirmationOptions && (
        <Box flexDirection="column" marginBottom={2}>
          <Text color="cyan" bold>
            Tips for getting started:
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">
              1. Ask questions, edit files, or run commands.
            </Text>
            <Text color="gray">2. Be specific for the best results.</Text>
            <Text color="gray">
              3. Press Shift+Tab to toggle auto-edit mode.
            </Text>
            <Text color="gray">4. /help for more information.</Text>
          </Box>
        </Box>
      )}

      <Box flexDirection="column" marginBottom={1}>
        <Text color="gray">
          Type your request in natural language.  ESC to clear, Ctrl+D to
          quit.
        </Text>
      </Box>

      <Box flexDirection="column" ref={scrollRef}>
        <ChatHistory
          entries={chatHistory}
          isConfirmationActive={!!confirmationOptions}
        />
      </Box>

      {/* Show confirmation dialog if one is pending */}
      {confirmationOptions && (
        <ConfirmationDialog
          operation={confirmationOptions.operation}
          filename={confirmationOptions.filename}
          showVSCodeOpen={confirmationOptions.showVSCodeOpen}
          content={confirmationOptions.content}
          onConfirm={handleConfirmation}
          onReject={handleRejection}
        />
      )}

      {!confirmationOptions && (
        <>
          <LoadingSpinner
            isActive={isProcessing || isStreaming}
            processingTime={processingTime}
            tokenCount={tokenCount}
          />

          <ChatInput
            input={input}
            cursorPosition={cursorPosition}
            isProcessing={isProcessing}
            isStreaming={isStreaming}
          />

          <Box flexDirection="row" marginTop={1}>
            <Box marginRight={2}>
              <Text color="cyan">
                {autoEditEnabled ? "▶" : "⏸"} auto-edit:{" "}
                {autoEditEnabled ? "on" : "off"}
              </Text>
              <Text color="gray" dimColor>
                {" "}
                (shift+tab)
              </Text>
            </Box>
            <BackendStatus agent={agent} />
            <MCPStatus />
            <ContextStatus agent={agent} />
            <PersonaStatus agent={agent} />
            <MoodStatus agent={agent} />
            <ActiveTaskStatus agent={agent} />
          </Box>

          <CommandSuggestions
            suggestions={commandSuggestions}
            input={input}
            selectedIndex={selectedCommandIndex}
            isVisible={showCommandSuggestions}
          />

          <ModelSelection
            models={availableModels}
            selectedIndex={selectedModelIndex}
            isVisible={showModelSelection}
            currentModel={agent.getCurrentModel()}
          />

          <RephraseMenu
            messageType={agent.getRephraseState()?.messageType || "user"}
            selectedIndex={selectedRephraseIndex}
            isVisible={showRephraseMenu}
          />
        </>
      )}
    </Box>
  );
}

// Main component that handles API key input or chat interface
export default function ChatInterface({
  agent,
  initialMessage,
  fresh,
}: ChatInterfaceProps) {
  const [currentAgent, setCurrentAgent] = useState<LLMAgent | null>(
    agent || null
  );

  const handleApiKeySet = (newAgent: LLMAgent) => {
    setCurrentAgent(newAgent);
  };

  if (!currentAgent) {
    return <ApiKeyInput onApiKeySet={handleApiKeySet} />;
  }

  return (
    <ChatInterfaceWithAgent
      agent={currentAgent}
      initialMessage={initialMessage}
      fresh={fresh}
    />
  );
}
