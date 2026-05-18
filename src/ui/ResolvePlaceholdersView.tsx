import React, { useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import type { CommandPlaceholderContract } from '../ai/types.js';

interface Props {
  placeholders: CommandPlaceholderContract[];
  onResolve: (values: Map<string, string>) => void;
  onBack: () => void;
  onCancel: () => void;
}

export const ResolvePlaceholdersView: React.FC<Props> = ({
  placeholders,
  onResolve,
  onBack,
  onCancel,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const [values, setValues] = useState<string[]>(placeholders.map(() => ''));
  const [buffer, setBuffer] = useState('');

  useInput((input: string, key: Key) => {
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }

    if (key.escape) {
      if (activeIndex === 0) {
        onBack();
      } else {
        const newValues = [...values];
        newValues[activeIndex] = '';
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
      <Text color="green">? Fill command placeholders</Text>
      <Box flexDirection="column" marginTop={1}>
        {placeholders.slice(0, activeIndex + 1).map((placeholder, index) => {
          const isCurrent = index === activeIndex;
          return (
            <Box key={index} flexDirection="column" marginBottom={1}>
              <Text>{placeholder.name}: {placeholder.description}</Text>
              <Box>
                <Text color="cyan">{'> '}</Text>
                <Text>{isCurrent ? buffer : values[index]}</Text>
                {isCurrent && <Text backgroundColor="white"> </Text>}
              </Box>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>
        Press Enter for next value, Esc to go back, Ctrl+C to cancel.
      </Text>
    </Box>
  );
};
