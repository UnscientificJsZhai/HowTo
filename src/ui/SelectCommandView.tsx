import React, { useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { CommandCandidateContract } from "../ai/types.js";

interface Props {
  candidates: CommandCandidateContract[];
  onSelect: (candidate: CommandCandidateContract) => void;
  onCancel: () => void;
}

export const SelectCommandView: React.FC<Props> = ({ candidates, onSelect, onCancel }) => {
  const [activeIndex, setActiveIndex] = useState(0);

  useInput((input: string, key: Key) => {
    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setActiveIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
    }

    if (key.downArrow) {
      setActiveIndex((prev) => (prev + 1) % candidates.length);
    }

    if (key.return) {
      onSelect(candidates[activeIndex]);
    }
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="green">? Select a command</Text>
      <Box flexDirection="column" marginTop={1}>
        {candidates.map((candidate, index) => {
          const isSelected = index === activeIndex;
          return (
            <Box key={index} flexDirection="column" marginBottom={1}>
              <Box>
                <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "> " : "  "}</Text>
                <Text inverse={isSelected} bold={isSelected}>
                  {candidate.title}
                </Text>
              </Box>
              <Box paddingLeft={4}>
                <Text color="gray">{candidate.command}</Text>
              </Box>
              <Box paddingLeft={4}>
                <Text italic color="dim">
                  {candidate.description}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>Use Up/Down to move, Enter to select, Esc or Ctrl+C to cancel.</Text>
    </Box>
  );
};
