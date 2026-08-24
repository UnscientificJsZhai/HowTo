import React, { useRef, useState } from "react";
import { Box, Text, type Key } from "ink";
import type { CommandCandidateContract } from "../ai/types.js";
import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";
import { SelectedCommandDisplay } from "./SelectedCommandDisplay.js";
import { toSingleLinePreview, toTailPreview } from "./single-line-preview.js";
import { isTextInputEvent } from "./text-input.js";
import { usePasteAwareInput } from "./use-paste-aware-input.js";
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
  availableRows: number;
  availableColumns: number;
  isInputActive?: boolean;
  onResolve: (resolved: ResolvedCommand) => void;
  onBack: () => void;
  onCancel: () => void;
}

export const ResolvePlaceholdersView: React.FC<Props> = ({
  candidate,
  availableRows,
  availableColumns,
  isInputActive = true,
  onResolve,
  onBack,
  onCancel,
}) => {
  const [resolutionState, setResolutionState] = useState<PlaceholderResolutionState>(() =>
    createPlaceholderResolution(candidate),
  );
  const resolutionStateRef = useRef(resolutionState);
  const { currentPlaceholder, currentBuffer, resolvedValues } =
    getPlaceholderResolutionView(resolutionState);

  const handleResolutionInput = (resolutionInput: PlaceholderResolutionInput) => {
    const transition = applyPlaceholderResolutionInput(resolutionStateRef.current, resolutionInput);

    switch (transition.type) {
      case "editing":
        resolutionStateRef.current = transition.state;
        setResolutionState(transition.state);
        return;
      case "back-to-selection":
        onBack();
        return;
      case "complete":
        onResolve(transition.resolved);
        return;
    }
  };

  usePasteAwareInput({
    onInput: (input: string, key: Key) => {
      if (!isInputActive || availableRows <= 0) return;

      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      const resolutionInput = toPlaceholderResolutionInput(input, key);
      if (resolutionInput !== undefined) {
        handleResolutionInput(resolutionInput);
      }
    },
    onPaste: (input) => {
      if (hasUnsafeTerminalControlCharacters(input)) {
        return;
      }

      handleResolutionInput({ type: "append", value: input });
    },
    isPasteActive: isInputActive && availableRows > 0,
  });

  if (availableRows <= 0) {
    return null;
  }

  if (availableRows === 1) {
    return (
      <OneRowPlaceholderEditor
        placeholderName={currentPlaceholder.name}
        buffer={currentBuffer.value}
        availableColumns={availableColumns}
      />
    );
  }

  if (availableRows === 2) {
    return (
      <Box flexDirection="column" height={2} maxHeight={2} overflowX="hidden" overflowY="hidden">
        <PlaceholderFieldLine
          name={currentPlaceholder.name}
          description={currentPlaceholder.description}
        />
        <CompactInputLine
          buffer={currentBuffer.value}
          availableColumns={availableColumns}
          controls=" Ent Esc"
        />
      </Box>
    );
  }

  const showHeading = availableRows >= 4;
  const showSelectedCommand = availableRows >= 10;

  return (
    <Box flexDirection="column" maxHeight={availableRows} overflowX="hidden" overflowY="hidden">
      {showSelectedCommand && (
        <SelectedCommandDisplay
          candidate={candidate}
          resolvedValues={resolvedValues}
          currentBuffer={currentBuffer}
        />
      )}
      {showHeading && (
        <Text color="green" wrap="truncate-end">
          ? Fill command placeholders
        </Text>
      )}
      <PlaceholderFieldLine
        name={currentPlaceholder.name}
        description={currentPlaceholder.description}
      />
      <CompactInputLine buffer={currentBuffer.value} availableColumns={availableColumns} />
      <Text dimColor wrap="truncate-end">
        Enter=next Esc=back
      </Text>
    </Box>
  );
};

const COMPACT_CONTROLS = " Ent Esc";
const COMPACT_CONTROLS_WIDTH = 8;

const OneRowPlaceholderEditor: React.FC<{
  placeholderName: string;
  buffer: string;
  availableColumns: number;
}> = ({ placeholderName, buffer, availableColumns }) => {
  const editableColumns = Math.max(0, availableColumns - COMPACT_CONTROLS_WIDTH);
  const maximumLabelWidth =
    editableColumns <= 1 ? editableColumns : Math.max(1, Math.floor(editableColumns / 2));
  const labelWidth = Math.min(maximumLabelWidth, toSingleLinePreview(placeholderName).length + 1);
  const bufferWidth = Math.max(0, editableColumns - labelWidth);

  return (
    <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
      <ClippedPlaceholderLabel name={placeholderName} width={labelWidth} />
      <TailClippedPlaceholderBuffer buffer={buffer} width={bufferWidth} />
      <Box width={COMPACT_CONTROLS_WIDTH} flexShrink={0}>
        <Text>{COMPACT_CONTROLS}</Text>
      </Box>
    </Box>
  );
};

const PlaceholderFieldLine: React.FC<{ name: string; description: string }> = ({
  name,
  description,
}) => (
  <Text wrap="truncate-end">
    <Text color="green">? </Text>
    {toSingleLinePreview(name)}: {toSingleLinePreview(description)}
  </Text>
);

const CompactInputLine: React.FC<{
  buffer: string;
  availableColumns: number;
  controls?: string;
}> = ({ buffer, availableColumns, controls }) => {
  const controlsWidth = controls === undefined ? 0 : COMPACT_CONTROLS_WIDTH;
  const bufferWidth = Math.max(0, availableColumns - 2 - controlsWidth);

  return (
    <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
      <Box width={2} flexShrink={0}>
        <Text color="cyan">{"> "}</Text>
      </Box>
      <TailClippedPlaceholderBuffer buffer={buffer} width={bufferWidth} />
      {controls !== undefined && (
        <Box width={controlsWidth} flexShrink={0}>
          <Text>{controls}</Text>
        </Box>
      )}
    </Box>
  );
};

const ClippedPlaceholderLabel: React.FC<{ name: string; width: number }> = ({ name, width }) => {
  if (width <= 0) {
    return null;
  }

  if (width === 1) {
    return (
      <Box width={1} flexShrink={0} overflowX="hidden">
        <Text>{toSingleLinePreview(name)}</Text>
      </Box>
    );
  }

  return (
    <Box width={width} flexShrink={0} overflowX="hidden">
      <Text>{toSingleLinePreview(name).slice(0, width - 1)}:</Text>
    </Box>
  );
};

const TailClippedPlaceholderBuffer: React.FC<{ buffer: string; width: number }> = ({
  buffer,
  width,
}) => {
  if (width <= 0) {
    return null;
  }

  return (
    <Box width={width} flexShrink={0} overflowX="hidden" overflowY="hidden">
      <Text>
        {toTailPreview(buffer, Math.max(0, width - 1))}
        <Text backgroundColor="white"> </Text>
      </Text>
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
