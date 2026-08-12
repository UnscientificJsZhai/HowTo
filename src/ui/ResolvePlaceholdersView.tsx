import React, { useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { CommandCandidateContract } from "../ai/types.js";
import { SelectedCommandDisplay } from "./SelectedCommandDisplay.js";
import { toSingleLinePreview } from "./single-line-preview.js";
import { isTextInputEvent } from "./text-input.js";
import {
  applyPlaceholderResolutionInput,
  createPlaceholderResolution,
  getPlaceholderResolutionView,
  type PlaceholderResolutionInput,
  type PlaceholderResolutionState,
  type ResolvedCommand,
} from "./placeholder-logic.js";

interface Props {
  candidate: CommandCandidateContract;
  isInputActive?: boolean;
  onResolve: (resolved: ResolvedCommand) => void;
  onBack: () => void;
  onCancel: () => void;
}

export const ResolvePlaceholdersView: React.FC<Props> = ({
  candidate,
  isInputActive = true,
  onResolve,
  onBack,
  onCancel,
}) => {
  const [resolutionState, setResolutionState] = useState<PlaceholderResolutionState>(() =>
    createPlaceholderResolution(candidate),
  );
  const { currentPlaceholder, currentBuffer, resolvedValues } =
    getPlaceholderResolutionView(resolutionState);

  useInput((input: string, key: Key) => {
    if (!isInputActive) return;

    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    const resolutionInput = toPlaceholderResolutionInput(input, key);
    if (!resolutionInput) {
      return;
    }

    const transition = applyPlaceholderResolutionInput(resolutionState, resolutionInput);

    switch (transition.type) {
      case "editing":
        setResolutionState(transition.state);
        return;
      case "back-to-selection":
        onBack();
        return;
      case "complete":
        onResolve(transition.resolved);
        return;
    }
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <SelectedCommandDisplay
        candidate={candidate}
        resolvedValues={resolvedValues}
        currentBuffer={currentBuffer}
      />

      <Text color="green">? Fill command placeholders</Text>
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text wrap="truncate-end">
            {toSingleLinePreview(currentPlaceholder.name)}:{" "}
            {toSingleLinePreview(currentPlaceholder.description)}
          </Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <Box flexGrow={1} overflowX="hidden">
              <Text wrap="truncate-start">
                {toSingleLinePreview(currentBuffer.value)}
                <Text backgroundColor="white"> </Text>
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>
      <Text dimColor>Press Enter for next value, Esc to go back, Ctrl+C to cancel.</Text>
    </Box>
  );
};

function toPlaceholderResolutionInput(
  input: string,
  key: Key,
): PlaceholderResolutionInput | undefined {
  if (key.escape) {
    return { type: "escape" };
  }

  if (key.return) {
    return { type: "commit" };
  }

  if (key.backspace || key.delete) {
    return { type: "delete" };
  }

  if (isTextInputEvent(input, key)) {
    return { type: "append", value: input };
  }

  return undefined;
}
