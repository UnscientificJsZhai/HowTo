import React, { useRef, useState } from "react";
import { Box, Text, useStdout, type Key } from "ink";
import type { DangerousCommandMatch } from "../safety/dangerous-command.js";
import type { CommandCandidateContract } from "../ai/types.js";
import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";
import { deleteLastGrapheme, isTextInputEvent } from "./text-input.js";
import { toSingleLinePreview, toTailPreview } from "./single-line-preview.js";
import { useExecutionPolicy } from "./InteractiveSessionProvider.js";
import { usePasteAwareInput } from "./use-paste-aware-input.js";

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

const DANGER_CONFIRMATION_PHRASE = "EXECUTE";
const DANGER_CONFIRMATION_SUFFIX = "+Enter; Esc/Ctrl+C |> ";

export function isDangerConfirmationInput(input: string): boolean {
  return input.toUpperCase() === DANGER_CONFIRMATION_PHRASE;
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
  const { policy, getPolicy } = useExecutionPolicy();
  const [buffer, setBuffer] = useState("");
  const bufferRef = useRef(buffer);
  const finishedRef = useRef(false);
  const { stdout } = useStdout();
  const stdoutColumns =
    typeof stdout.columns === "number" && stdout.columns > 0 ? stdout.columns : 80;
  const columns = availableColumns ?? stdoutColumns;

  usePasteAwareInput({
    onInput: (input: string, key: Key) => {
      if (finishedRef.current || !isInputActive || availableRows <= 0 || isDone) return;

      if (key.ctrl && input === "c") {
        finishedRef.current = true;
        onCancel();
        return;
      }

      if (key.escape) {
        finishedRef.current = true;
        onCancel();
        return;
      }

      if (getPolicy() === "print") {
        if (key.return) {
          finishedRef.current = true;
          onConfirm();
        }
        return;
      }

      if (danger) {
        if (key.return) {
          finishedRef.current = true;
          if (isDangerConfirmationInput(bufferRef.current)) {
            onConfirm();
          } else {
            onCancel();
          }
          return;
        }

        if (key.backspace || key.delete) {
          updateBuffer(deleteLastGrapheme);
          return;
        }

        if (isTextInputEvent(input, key)) {
          updateBuffer((previous) => previous + input);
        }
      } else if (key.return) {
        finishedRef.current = true;
        onConfirm();
      }
    },
    onPaste: (input) => {
      if (
        finishedRef.current ||
        getPolicy() === "print" ||
        danger === undefined ||
        hasUnsafeTerminalControlCharacters(input)
      ) {
        return;
      }

      updateBuffer((previous) => previous + input);
    },
    isPasteActive: isInputActive && availableRows > 0 && !isDone,
  });

  function updateBuffer(update: (previous: string) => string): void {
    const nextBuffer = update(bufferRef.current);
    bufferRef.current = nextBuffer;
    setBuffer(nextBuffer);
  }

  if (availableRows <= 0) {
    return null;
  }

  if (isDone) {
    return <CommandPreview command={command} />;
  }

  if (policy === "print") {
    if (availableRows === 1) {
      return (
        <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
          <CommandPreview command={command} prefix="仅输出:" prefixWidth={7} />
          <Box width={8} flexShrink={0}>
            <Text> Ent Esc</Text>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        {danger && availableRows >= 3 && (
          <Text color="red" wrap="truncate-middle">
            Risk: {toSingleLinePreview(danger.reason)} [{toSingleLinePreview(danger.rule)}]
          </Text>
        )}
        <Text wrap="truncate-middle">仅输出: {toSingleLinePreview(command)}</Text>
        <Text wrap="truncate-end">Enter输出 Esc取消</Text>
      </Box>
    );
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

    // 完整提示、确认短语和光标放不下时，缩短提示，为输入尾部保留空间。
    const compactPrompt =
      columns < DANGER_CONFIRMATION_PHRASE.length * 2 + DANGER_CONFIRMATION_SUFFIX.length + 1;
    const promptSuffix = compactPrompt ? ":" : DANGER_CONFIRMATION_SUFFIX;
    const promptWidth = DANGER_CONFIRMATION_PHRASE.length + promptSuffix.length;
    const controls = compactPrompt ? " Ent Esc" : "";

    return (
      <Box flexDirection="column">
        <Text color="red" bold wrap="truncate-middle">
          Risk: {toSingleLinePreview(danger.reason)} [{toSingleLinePreview(danger.rule)}]
        </Text>
        <Text wrap="truncate-middle">
          Final command: <Text color="yellow">{toSingleLinePreview(command)}</Text>
        </Text>
        {!isDone && (
          <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
            <Box width={promptWidth} flexShrink={0}>
              <Text>
                <Text color="yellow">{DANGER_CONFIRMATION_PHRASE}</Text>
                {promptSuffix}
              </Text>
            </Box>
            <TailClippedBuffer
              buffer={buffer}
              width={Math.max(1, columns - promptWidth - controls.length)}
              showCursor
            />
            {controls !== "" && (
              <Box width={controls.length} flexShrink={0}>
                <Text>{controls}</Text>
              </Box>
            )}
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
