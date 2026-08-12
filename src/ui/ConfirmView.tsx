import React, { useState } from "react";
import { Box, Text, useInput, useStdout, type Key } from "ink";
import type { DangerousCommandMatch } from "../safety/dangerous-command.js";
import type { CommandCandidateContract } from "../ai/types.js";
import { isTextInputEvent } from "./text-input.js";
import { toSingleLinePreview, toTailPreview } from "./single-line-preview.js";

interface Props {
  candidate: CommandCandidateContract;
  command: string;
  resolvedValues: Map<string, string>;
  danger?: DangerousCommandMatch;
  onConfirm: () => void;
  onCancel: () => void;
  isDone?: boolean;
  isInputActive?: boolean;
  availableRows?: number;
  availableColumns?: number;
}

export function isDangerConfirmationInput(input: string): boolean {
  return input.toUpperCase() === "EXECUTE";
}

export const ConfirmView: React.FC<Props> = ({
  command,
  danger,
  onConfirm,
  onCancel,
  isDone = false,
  isInputActive = true,
  availableRows = 3,
  availableColumns,
}) => {
  const [buffer, setBuffer] = useState("");
  const { stdout } = useStdout();
  const stdoutColumns =
    typeof stdout.columns === "number" && stdout.columns > 0 ? stdout.columns : 80;
  const columns = availableColumns ?? stdoutColumns;

  useInput((input: string, key: Key) => {
    if (!isInputActive || availableRows <= 0 || isDone) return;

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

  if (availableRows <= 0) {
    return null;
  }

  if (isDone) {
    return <CommandPreview command={command} />;
  }

  if (!danger && availableRows === 1) {
    return (
      <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
        <CommandPreview command={command} />
        <Box width={10} flexShrink={0}>
          <Text> Enter Esc</Text>
        </Box>
      </Box>
    );
  }

  if (!danger && availableRows === 2) {
    return (
      <Box flexDirection="column" height={2} maxHeight={2} overflowX="hidden" overflowY="hidden">
        <CommandPreview command={command} prefix="Final:" prefixWidth={7} />
        <Text>Enter=run Esc=cancel</Text>
      </Box>
    );
  }

  if (danger) {
    if (availableRows === 1) {
      return (
        <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
          <CommandPreview command={command} minWidth={2} />
          <Box width={3} flexShrink={0}>
            <Text>!X:</Text>
          </Box>
          <TailClippedBuffer buffer={buffer} width={7} />
          <Box width={8} flexShrink={0}>
            <Text> Ent Esc</Text>
          </Box>
        </Box>
      );
    }

    if (availableRows === 2) {
      return (
        <Box flexDirection="column" height={2} maxHeight={2} overflowX="hidden" overflowY="hidden">
          <CommandPreview command={command} prefix="Danger:" prefixWidth={8} />
          <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
            <Box width={10} flexShrink={0}>
              <Text>X=EXECUTE:</Text>
            </Box>
            <TailClippedBuffer buffer={buffer} width={Math.max(1, columns - 18)} />
            <Box width={8} flexShrink={0}>
              <Text> Ent Esc</Text>
            </Box>
          </Box>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Text color="red" bold wrap="truncate-middle">
          Risk: {toSingleLinePreview(danger.reason)} [{toSingleLinePreview(danger.rule)}]
        </Text>
        <Text wrap="truncate-middle">
          Final command: <Text color="yellow">{toSingleLinePreview(command)}</Text>
        </Text>
        {!isDone && (
          <Box>
            <Text wrap="truncate-end">
              <Text color="yellow">EXECUTE</Text>+Enter; Esc/Ctrl+C |{"> "}
            </Text>
            <TailClippedBuffer buffer={buffer} width={Math.max(1, columns - 29)} showCursor />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-middle">
        Final command: <Text color="yellow">{toSingleLinePreview(command)}</Text>
      </Text>
      {!isDone && (
        <Text wrap="truncate-end">
          <Text color="green">Enter</Text> execute; <Text color="gray">Esc/Ctrl+C</Text> cancel.
        </Text>
      )}
    </Box>
  );
};

const CommandPreview: React.FC<{
  command: string;
  minWidth?: number;
  prefix?: string;
  prefixWidth?: number;
}> = ({ command, minWidth = 1, prefix, prefixWidth }) => (
  <Box
    flexGrow={1}
    flexShrink={1}
    minWidth={minWidth}
    height={1}
    maxHeight={1}
    overflowX="hidden"
    overflowY="hidden"
  >
    {prefix !== undefined && (
      <Box width={prefixWidth} flexShrink={0}>
        <Text>{prefix}</Text>
      </Box>
    )}
    <Box
      flexGrow={1}
      flexShrink={1}
      minWidth={1}
      height={1}
      maxHeight={1}
      overflowX="hidden"
      overflowY="hidden"
    >
      <Text>{toSingleLinePreview(command)}</Text>
    </Box>
  </Box>
);

const TailClippedBuffer: React.FC<{
  buffer: string;
  showCursor?: boolean;
  width: number;
}> = ({ buffer, showCursor = false, width }) => (
  <Box
    width={width}
    flexShrink={0}
    height={1}
    maxHeight={1}
    justifyContent="flex-end"
    overflowX="hidden"
    overflowY="hidden"
  >
    <Text>
      {toTailPreview(buffer, Math.max(0, width - (showCursor ? 1 : 0)))}
      {showCursor && <Text backgroundColor="white"> </Text>}
    </Text>
  </Box>
);
