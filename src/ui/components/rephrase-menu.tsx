import React from "react";
import { Box, Text } from "ink";

interface RephraseMenuProps {
  messageType: "user" | "system";
  selectedIndex: number;
  isVisible: boolean;
}

export const RephraseMenu = React.memo(function RephraseMenu({
  messageType,
  selectedIndex,
  isVisible,
}: RephraseMenuProps) {
  if (!isVisible) return null;

  const toggleType = messageType === "user" ? "system" : "user";
  const options = [
    "Keep as new response",
    "Replace original response",
    "Try again",
    `Resend as ${toggleType} message`,
    "Cancel",
  ];

  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginBottom={1}>
        <Text color="cyan">Rephrase options:</Text>
      </Box>
      {options.map((option, index) => (
        <Box key={index} paddingLeft={1}>
          <Text
            color={index === selectedIndex ? "black" : "white"}
            backgroundColor={index === selectedIndex ? "cyan" : undefined}
          >
            {index + 1}. {option}
          </Text>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          ↑↓ navigate • 1-5 quick select • Enter confirm • Esc cancel
        </Text>
      </Box>
    </Box>
  );
});
