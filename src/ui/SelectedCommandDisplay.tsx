import React from 'react';
import { Box, Text } from 'ink';
import type { CommandCandidateContract } from '../ai/types.js';

interface Props {
  candidate: CommandCandidateContract;
  resolvedValues: Map<string, string>;
  currentBuffer?: { name: string; value: string };
}

export const SelectedCommandDisplay: React.FC<Props> = ({
  candidate,
  resolvedValues,
  currentBuffer,
}) => {
  // Split command by {{placeholder}} pattern, keeping the delimiters
  const parts = candidate.command.split(/({{.*?}})/);

  return (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text color="cyan" bold>
          {'> '}
        </Text>
        <Text bold>{candidate.title}</Text>
      </Box>

      <Box marginLeft={2}>
        <Text>
          {parts.map((part, index) => {
            const match = part.match(/^{{(.*)}}$/);
            if (match) {
              const placeholderName = match[1];
              
              // If it's the current buffer, show the buffer in yellow
              if (currentBuffer && currentBuffer.name === placeholderName) {
                return (
                  <Text key={index} color="yellow">
                    {currentBuffer.value || part}
                  </Text>
                );
              }

              // If it's already resolved, show the value in yellow
              if (resolvedValues.has(placeholderName)) {
                return (
                  <Text key={index} color="yellow">
                    {resolvedValues.get(placeholderName)}
                  </Text>
                );
              }

              // Otherwise show the original {{placeholder}} in default gray
              return (
                <Text key={index} color="gray">
                  {part}
                </Text>
              );
            }

            // Normal text
            return <Text key={index}>{part}</Text>;
          })}
        </Text>
      </Box>

      <Box marginLeft={2}>
        <Text italic color="dim">
          {candidate.description}
        </Text>
      </Box>
    </Box>
  );
};
