import React, { useMemo } from "react";
import { Box, Text, useStdout } from "ink";

interface ChatInputProps {
  input: string;
  cursorPosition: number;
  isProcessing: boolean;
  isStreaming: boolean;
}

export const ChatInput = React.memo(({
  input,
  cursorPosition,
  isProcessing,
  isStreaming,
}: ChatInputProps) => {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80;

  // Reserve space for border (2 chars) and padding
  const boxWidth = Math.max(terminalWidth - 4, 40);

  const showCursor = !isProcessing && !isStreaming;
  const borderColor = isProcessing || isStreaming ? "yellow" : "blue";

  const displayText = useMemo(() => {
    const lines = input.split("\n");
    const isMultiline = lines.length > 1;

    if (!isMultiline) {
      const beforeCursor = input.slice(0, cursorPosition);
      const cursorChar = input.slice(cursorPosition, cursorPosition + 1) || " ";
      const afterCursor = input.slice(cursorPosition + 1);

      if (showCursor) {
        return "\u001b[36m❯ \u001b[0m" + beforeCursor + "\u001b[7m" + cursorChar + "\u001b[27m" + afterCursor;
      } else {
        return "\u001b[36m❯ \u001b[0m" + input;
      }
    }

    // Calculate cursor position across lines
    let currentLineIndex = 0;
    let currentCharIndex = 0;
    let totalChars = 0;

    for (let i = 0; i < lines.length; i++) {
      if (totalChars + lines[i].length >= cursorPosition) {
        currentLineIndex = i;
        currentCharIndex = cursorPosition - totalChars;
        break;
      }
      totalChars += lines[i].length + 1;
    }

    // Multiline: build entire display with prompt chars and cursor
    let result = "";
    for (let i = 0; i < lines.length; i++) {
      const promptChar = i === 0 ? "❯" : "│";
      const line = lines[i];

      if (i === currentLineIndex && showCursor) {
        const beforeCursor = line.slice(0, currentCharIndex);
        const cursorChar = line.slice(currentCharIndex, currentCharIndex + 1) || " ";
        const afterCursor = line.slice(currentCharIndex + 1);
        result += "\u001b[36m" + promptChar + " \u001b[0m" + beforeCursor + "\u001b[7m" + cursorChar + "\u001b[27m" + afterCursor;
      } else {
        result += "\u001b[36m" + promptChar + " \u001b[0m" + line;
      }

      if (i < lines.length - 1) result += "\n";
    }
    return result;
  }, [input, cursorPosition, showCursor]);
  return (
    <Box
      width={boxWidth}
      borderStyle="round"
      borderColor={borderColor}
      paddingX={0}
      paddingY={0}
      marginTop={1}
    >
      <Text>{displayText}</Text>
    </Box>
  );
});
