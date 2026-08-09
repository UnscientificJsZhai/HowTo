import React, { useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { DangerousCommandMatch } from "../safety/dangerous-command.js";
import type { CommandCandidateContract } from "../ai/types.js";
import { SelectedCommandDisplay } from "./SelectedCommandDisplay.js";
import { isTextInputEvent } from "./text-input.js";

interface Props {
  candidate: CommandCandidateContract;
  command: string;
  resolvedValues: Map<string, string>;
  danger?: DangerousCommandMatch;
  onConfirm: () => void;
  onCancel: () => void;
  isDone?: boolean;
}

export function isDangerConfirmationInput(input: string): boolean {
  return input.toUpperCase() === "EXECUTE";
}

export const ConfirmView: React.FC<Props> = ({
  candidate,
  command,
  resolvedValues,
  danger,
  onConfirm,
  onCancel,
  isDone = false,
}) => {
  const [buffer, setBuffer] = useState("");

  useInput((input: string, key: Key) => {
    if (isDone) return;

    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }

    if (danger) {
      if (key.return) {
        if (isDangerConfirmationInput(buffer)) {
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

      if (isTextInputEvent(input, key)) {
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
        <Text color="red" bold>
          Dangerous command detected.
        </Text>
        <Text>Rule: {danger.rule}</Text>
        <Text>Risk: {danger.reason}</Text>
        <Box marginTop={1} flexDirection="column">
          <SelectedCommandDisplay candidate={candidate} resolvedValues={resolvedValues} />
          <Text>
            Final command: <Text color="yellow">{command}</Text>
          </Text>
        </Box>
        {!isDone && (
          <>
            <Box marginTop={1}>
              <Text>
                Type <Text color="yellow">EXECUTE</Text> to continue, or anything else to cancel.
              </Text>
            </Box>
            <Box>
              <Text color="cyan">{"> "}</Text>
              <Text>{buffer}</Text>
              <Text backgroundColor="white"> </Text>
            </Box>
          </>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <SelectedCommandDisplay candidate={candidate} resolvedValues={resolvedValues} />
      <Text>
        Final command: <Text color="yellow">{command}</Text>
      </Text>
      {!isDone && (
        <Box marginTop={1}>
          <Text>
            Press <Text color="green">Enter</Text> to execute, <Text color="gray">Esc</Text> or{" "}
            <Text color="gray">Ctrl+C</Text> to cancel.
          </Text>
        </Box>
      )}
    </Box>
  );
};
