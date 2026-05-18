import React, { useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import type { DangerousCommandMatch } from '../safety/dangerous-command.js';

interface Props {
  command: string;
  danger?: DangerousCommandMatch;
  onConfirm: () => void;
  onCancel: () => void;
}

export const ConfirmView: React.FC<Props> = ({ command, danger, onConfirm, onCancel }) => {
  const [buffer, setBuffer] = useState('');

  useInput((input: string, key: Key) => {
    if (key.ctrl && input === 'c') {
      onCancel();
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (danger) {
      if (key.return) {
        if (buffer === 'EXECUTE') {
          onConfirm();
        } else {
          onCancel();
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
    } else {
      if (key.return) {
        onConfirm();
      }
    }
  });

  if (danger) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color="red" bold>Dangerous command detected.</Text>
        <Text>Rule: {danger.rule}</Text>
        <Text>Risk: {danger.reason}</Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>Final command:</Text>
          <Text>{command}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>Type <Text color="yellow">EXECUTE</Text> to continue, or anything else to cancel.</Text>
        </Box>
        <Box>
          <Text color="cyan">{'> '}</Text>
          <Text>{buffer}</Text>
          <Text backgroundColor="white"> </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold>Final command:</Text>
      <Text>{command}</Text>
      <Box marginTop={1}>
        <Text>Press <Text color="green">Enter</Text> to execute, <Text color="gray">Esc</Text> or <Text color="gray">Ctrl+C</Text> to cancel.</Text>
      </Box>
    </Box>
  );
};
