import React, { useState, useMemo } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { CommandCandidateContract, CommandPlaceholderContract } from "../ai/types.js";
import { SelectedCommandDisplay } from "./SelectedCommandDisplay.js";

interface Props {
  candidate: CommandCandidateContract;
  placeholders: CommandPlaceholderContract[];
  onResolve: (values: Map<string, string>) => void;
  onBack: () => void;
  onCancel: () => void;
}

export const ResolvePlaceholdersView: React.FC<Props> = ({
  candidate,
  placeholders,
  onResolve,
  onBack,
  onCancel,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [values, setValues] = useState<string[]>(placeholders.map(() => ""));
  const [buffer, setBuffer] = useState("");

  const resolvedValuesMap = useMemo(() => {
    const map = new Map<string, string>();
    placeholders.forEach((p, i) => {
      if (i < activeIndex) {
        map.set(p.name, values[i]);
      }
    });
    return map;
  }, [placeholders, activeIndex, values]);

  const currentBuffer = useMemo(
    () => ({
      name: placeholders[activeIndex].name,
      value: buffer,
    }),
    [placeholders, activeIndex, buffer],
  );

  useInput((input: string, key: Key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      if (activeIndex === 0) {
        onBack();
      } else {
        const newValues = [...values];
        newValues[activeIndex] = "";
        setValues(newValues);
        setActiveIndex((prev) => prev - 1);
        setBuffer(values[activeIndex - 1]);
      }
      return;
    }

    if (key.return) {
      const newValues = [...values];
      newValues[activeIndex] = buffer;
      setValues(newValues);

      if (activeIndex === placeholders.length - 1) {
        const resultMap = new Map<string, string>();
        placeholders.forEach((p, i) => {
          resultMap.set(p.name, newValues[i]);
        });
        onResolve(resultMap);
      } else {
        setActiveIndex((prev) => prev + 1);
        setBuffer(values[activeIndex + 1]);
      }
      return;
    }

    if (key.backspace || key.delete) {
      setBuffer((prev) => prev.slice(0, -1));
      return;
    }

    if (input && !Object.values(key).some(Boolean)) {
      setBuffer((prev) => prev + input);
    }
    // Handle space and other printable characters that might be in key but not in input if needed
    // However ink's useInput input is usually the string.
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <SelectedCommandDisplay
        candidate={candidate}
        resolvedValues={resolvedValuesMap}
        currentBuffer={currentBuffer}
      />

      <Text color="green">? Fill command placeholders</Text>
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {placeholders[activeIndex].name}: {placeholders[activeIndex].description}
          </Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <Text>{buffer}</Text>
            <Text backgroundColor="white"> </Text>
          </Box>
        </Box>
      </Box>
      <Text dimColor>Press Enter for next value, Esc to go back, Ctrl+C to cancel.</Text>
    </Box>
  );
};
