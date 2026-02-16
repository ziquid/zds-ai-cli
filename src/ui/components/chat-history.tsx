import React from "react";
import { Box, Text } from "ink";
import { ChatEntry } from "../../agent/llm-agent.js";
import { DiffRenderer } from "./diff-renderer.js";
import { MarkdownRenderer } from "../utils/markdown-renderer.js";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions.js";

interface ChatHistoryProps {
  entries: ChatEntry[];
  isConfirmationActive?: boolean;
}

const TRUNCATE_LINES = 3;

// Helper function to extract text content from ChatEntry (handles both string and array content)
function getTextContent(content?: string | ChatCompletionContentPart[]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  // For content arrays, extract and concatenate text parts
  return content
    .filter(item => item.type === "text")
    .map(item => "text" in item ? item.text : "")
    .join(" ");
}

// Helper function to truncate content to first N lines
function truncateContent(content: string, maxLines: number = TRUNCATE_LINES): { truncated: string; hiddenLines: number } {
  const lines = content.split("\n");
  // Only truncate if we're hiding more than 2 lines (otherwise showing "… +1 lines" is worse UX)
  if (lines.length <= maxLines + 2) {
    return { truncated: content, hiddenLines: 0 };
  }
  const truncated = lines.slice(0, maxLines).join("\n");
  const hiddenLines = lines.length - maxLines;
  return { truncated, hiddenLines };
}

// Memoized ChatEntry component to prevent unnecessary re-renders
const MemoizedChatEntry = React.memo(
  ({ entry, index }: { entry: ChatEntry; index: number }) => {
    const renderDiff = (diffContent: string, filename?: string) => {
      return (
        <DiffRenderer
          diffContent={diffContent}
          filename={filename}
          terminalWidth={80}
        />
      );
    };

    const renderFileContent = (content: string) => {
      const lines = content.split("\n");

      // Calculate minimum indentation like DiffRenderer does
      let baseIndentation = Infinity;
      for (const line of lines) {
        if (line.trim() === "") continue;
        const firstCharIndex = line.search(/\S/);
        const currentIndent = firstCharIndex === -1 ? 0 : firstCharIndex;
        baseIndentation = Math.min(baseIndentation, currentIndent);
      }
      if (!isFinite(baseIndentation)) {
        baseIndentation = 0;
      }

      return lines.map((line, index) => {
        const displayContent = line.substring(baseIndentation);
        return (
          <Text key={index} color="gray">
            {displayContent}
          </Text>
        );
      });
    };

    switch (entry.type) {
      case "user":
        return (
          <Box key={index} flexDirection="column" marginTop={1}>
            <Box>
              <Text color="gray">
                {">"} {getTextContent(entry.originalContent ?? entry.content)}
              </Text>
            </Box>
          </Box>
        );

      case "assistant":
        return (
          <Box key={index} flexDirection="column" marginTop={1}>
            <Box flexDirection="row" alignItems="flex-start">
              <Text color="white">⏺ </Text>
              <Box flexDirection="column" flexGrow={1}>
                {entry.preserveFormatting ? (
                  // Preserve formatting: split lines and render each line as-is
                  (() => {
                    const content = (getTextContent(entry.content)).trim();
                    const lines = content.split('\n');
                    return (
                      <Box flexDirection="column">
                        {lines.map((line, lineIdx) => (
                          <Text key={lineIdx} color="white">{line}</Text>
                        ))}
                      </Box>
                    );
                  })()
                ) : entry.tool_calls ? (
                  // If there are tool calls, just show plain text
                  <Text color="white">{(getTextContent(entry.content)).trim()}</Text>
                ) : (
                  // Normal chat: use MarkdownRenderer with reflowText
                  <MarkdownRenderer content={(getTextContent(entry.content)).trim()} />
                )}
                {entry.isStreaming && <Text color="cyan">█</Text>}
              </Box>
            </Box>
          </Box>
        );

      case "tool_call":
      case "tool_result":
        const getToolActionName = (toolName: string) => {
          // Handle MCP tools with mcp__servername__toolname format
          if (toolName.startsWith("mcp__")) {
            const parts = toolName.split("__");
            if (parts.length >= 3) {
              const serverName = parts[1];
              const actualToolName = parts.slice(2).join("__");
              return `${serverName.charAt(0).toUpperCase() + serverName.slice(1)}/${actualToolName.replace(/_/g, " ")}`;
            }
          }

          // Return the actual tool name from the function call
          return toolName;
        };

        const toolName = entry.toolCall?.function?.name || "unknown tool";
        const actionName = getToolActionName(toolName);

        // If toolCall is completely missing, show error state
        if (!entry.toolCall || !entry.toolCall.function) {
          return (
            <Box key={index} flexDirection="column" marginTop={1}>
              <Box>
                <Text color="magenta">⏺</Text>
                <Text color="red"> [Missing tool call data]</Text>
              </Box>
            </Box>
          );
        }

        const getFilePath = (toolCall: any) => {
          if (toolCall?.function?.arguments) {
            try {
              const args = JSON.parse(toolCall.function.arguments);
              if (toolCall.function.name === "universalSearch") {
                return args.query;
              }
              return args.path || args.file_path || args.command || "";
            } catch {
              return "";
            }
          }
          return "";
        };

        const filePath = getFilePath(entry.toolCall);
        const isExecuting = entry.type === "tool_call" || !entry.toolResult;
        
        // Format JSON content for better readability
        const formatToolContent = (content: string, toolName: string) => {
          if (toolName.startsWith("mcp__")) {
            try {
              // Try to parse as JSON and format it
              const parsed = JSON.parse(content);
              if (Array.isArray(parsed)) {
                // For arrays, show a summary instead of full JSON
                return `Found ${parsed.length} items`;
              } else if (typeof parsed === 'object') {
                // For objects, show a formatted version
                return JSON.stringify(parsed, null, 2);
              }
            } catch {
              // If not JSON, return as is
              return content;
            }
          }
          return content;
        };
        const contentText = getTextContent(entry.content);
        const shouldShowDiff =
          entry.toolCall?.function?.name === "str_replace_editor" &&
          entry.toolResult?.success &&
          contentText.includes("Updated") &&
          contentText.includes("---") &&
          contentText.includes("+++");

        const shouldShowFileContent =
          (entry.toolCall?.function?.name === "view_file" ||
            entry.toolCall?.function?.name === "create_file") &&
          entry.toolResult?.success &&
          !shouldShowDiff;

        return (
          <Box key={index} flexDirection="column" marginTop={1}>
            <Box>
              <Text color="magenta">⏺</Text>
              <Text color="white">
                {" "}
                {filePath ? `${actionName}(${filePath})` : actionName}
              </Text>
            </Box>
            <Box marginLeft={2} flexDirection="column">
              {isExecuting ? (
                <Text color="cyan">⎿ Executing...</Text>
              ) : (() => {
                const content = getTextContent(entry.content);
                const displayOutput = entry.toolResult?.displayOutput;

                // Only show displayOutput if it exists and provides additional value
                const showDisplayOutput = displayOutput && displayOutput.trim() !== content.trim();
                const { truncated, hiddenLines } = truncateContent(content);

                return (
                  <>
                    {showDisplayOutput && (
                      <Text color="gray">⎿ {displayOutput}</Text>
                    )}
                    <Text color="gray">{showDisplayOutput ? truncated : `⎿ ${truncated}`}</Text>
                    {hiddenLines > 0 && (
                      <Text color="gray" dimColor>   … +{hiddenLines} lines (ctrl+o to expand)</Text>
                    )}
                  </>
                );
              })()}
            </Box>
            {shouldShowDiff && !isExecuting && (
              <Box marginLeft={4} flexDirection="column">
                {renderDiff(getTextContent(entry.content), filePath)}
              </Box>
            )}
          </Box>
        );

      case "system":
        return (
          <Box key={index} flexDirection="column" marginTop={1}>
            <Box>
              <Text color="blue">🔧 System: </Text>
              <Box flexDirection="column" marginLeft={2}>
                <Text color="blue" dimColor>
                  {(getTextContent(entry.content)).split('\n').slice(0, 3).join('\n')}
                  {(getTextContent(entry.content)).split('\n').length > 3 ? '\n...' : ''}
                </Text>
              </Box>
            </Box>
          </Box>
        );

      default:
        return null;
    }
  }
);

MemoizedChatEntry.displayName = "MemoizedChatEntry";

export const ChatHistory = React.memo(function ChatHistory({
  entries,
  isConfirmationActive = false,
}: ChatHistoryProps) {
  // Filter out tool_call entries with "Executing..." when confirmation is active
  const filteredEntries = isConfirmationActive
    ? entries.filter(
        (entry) =>
          !(entry.type === "tool_call" && getTextContent(entry.content) === "Executing...")
      )
    : entries;

  return (
    <Box flexDirection="column">
      {filteredEntries.slice(-11).map((entry, index) => {
        // Ensure timestamp is a Date object (defensive check)
        const timestamp = entry.timestamp instanceof Date
          ? entry.timestamp
          : new Date(entry.timestamp);

        return (
          <MemoizedChatEntry
            key={`${timestamp.getTime()}-${index}`}
            entry={entry}
            index={index}
          />
        );
      })}
    </Box>
  );
});
