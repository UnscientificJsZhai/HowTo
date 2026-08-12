import React, { useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { AppConfig } from "../config.js";
import { usePhysicalStdoutRows } from "../ui/resize-safe-output.js";
import { toSingleLinePreview } from "../ui/single-line-preview.js";
import type { InitializationValues } from "./index.js";
import {
  applyInitializationInput,
  createInitialInitializationState,
  getProviderOptions,
  type InitializationFieldState,
  type InitializationState,
} from "./state.js";

interface Props {
  onSubmit: (values: InitializationValues) => Promise<AppConfig>;
  onComplete: (config: AppConfig) => void;
  onCancel: () => void;
  onError: (error: Error) => void;
}

type SubmitStatus = "editing" | "saving" | "error" | "cancelled";

const RICH_LAYOUT_MIN_ROWS = 15;

export const InitializationApp: React.FC<Props> = ({ onSubmit, onComplete, onCancel, onError }) => {
  const rows = usePhysicalStdoutRows();
  const [state, setState] = useState<InitializationState>(createInitialInitializationState);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("editing");
  const [errorMessage, setErrorMessage] = useState("");
  const frameRows = Math.max(0, rows - 1);

  useInput(
    (input: string, key: Key) => {
      if (frameRows === 0) {
        return;
      }

      if (submitStatus !== "editing") {
        return;
      }

      const update = applyInitializationInput(state, { input, key });
      setState(update.state);

      if (update.cancelled) {
        setSubmitStatus("cancelled");
        onCancel();
        return;
      }

      if (update.completedValues !== undefined) {
        setSubmitStatus("saving");
        onSubmit(update.completedValues)
          .then((config) => {
            onComplete(config);
          })
          .catch((error: unknown) => {
            const appError = normalizeError(error);
            setErrorMessage(appError.message);
            setSubmitStatus("error");
            onError(appError);
          });
      }
    },
    { isActive: frameRows === 0 || submitStatus === "editing" },
  );

  let content: React.ReactNode;
  if (submitStatus === "saving") {
    content = (
      <InitializationStatusLine
        frameRows={frameRows}
        message="Saving howto configuration..."
        color="green"
      />
    );
  } else if (submitStatus === "error") {
    content = (
      <InitializationStatusLine
        frameRows={frameRows}
        message={`Error: ${errorMessage}`}
        color="red"
      />
    );
  } else if (submitStatus === "cancelled") {
    content = (
      <InitializationStatusLine
        frameRows={frameRows}
        message="Initialization cancelled."
        dimColor
      />
    );
  } else if (state.step === "provider") {
    content = <ProviderStep selectedIndex={state.selectedIndex} frameRows={frameRows} />;
  } else {
    content = <InputStep state={state} frameRows={frameRows} />;
  }

  return (
    <Box
      display={frameRows > 0 ? "flex" : "none"}
      flexDirection="column"
      maxHeight={frameRows}
      overflowX="hidden"
      overflowY="hidden"
    >
      {content}
    </Box>
  );
};

const ClippedLine: React.FC<{
  children: React.ReactNode;
  color?: React.ComponentProps<typeof Text>["color"];
  dimColor?: boolean;
  prefix?: string;
  prefixWidth?: number;
}> = ({ children, color, dimColor = false, prefix, prefixWidth }) => (
  <Box width="100%" height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
    {prefix === undefined ? (
      <Text color={color} dimColor={dimColor}>
        {children}
      </Text>
    ) : (
      <>
        <Box width={prefixWidth} flexShrink={0}>
          <Text color={color} dimColor={dimColor}>
            {prefix}
          </Text>
        </Box>
        <Box
          flexGrow={1}
          flexShrink={1}
          minWidth={1}
          height={1}
          maxHeight={1}
          overflowX="hidden"
          overflowY="hidden"
        >
          <Text color={color} dimColor={dimColor}>
            {children}
          </Text>
        </Box>
      </>
    )}
  </Box>
);

const ProviderStep: React.FC<{ selectedIndex: number | null; frameRows: number }> = ({
  selectedIndex,
  frameRows,
}) => {
  const providers = getProviderOptions();
  const selectedProvider = selectedIndex === null ? undefined : providers[selectedIndex];
  const providerSelectionLine =
    selectedProvider === "openai"
      ? "> openai 2 gemini"
      : selectedProvider === "gemini"
        ? "1 openai > gemini"
        : "1 openai 2 gemini";

  if (frameRows < RICH_LAYOUT_MIN_ROWS) {
    if (frameRows === 1) {
      const compactSelection =
        selectedProvider === "openai" ? "O" : selectedProvider === "gemini" ? "G" : "-";
      return (
        <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
          <Text>{`O/G:${compactSelection} UD Ent 1/2 Esc`}</Text>
        </Box>
      );
    }

    if (frameRows <= 3) {
      return (
        <Box
          flexDirection="column"
          height={frameRows}
          maxHeight={frameRows}
          overflowX="hidden"
          overflowY="hidden"
        >
          {frameRows === 3 && <Text color="green">? Choose provider</Text>}
          <ClippedLine>{providerSelectionLine}</ClippedLine>
          <Text dimColor>UD Enter 1/2 Esc</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column" maxHeight={4} overflowX="hidden" overflowY="hidden">
        <ClippedLine>howto needs an AI provider before it can call AI.</ClippedLine>
        <ClippedLine color="green">? Choose provider</ClippedLine>
        <ClippedLine>{providerSelectionLine}</ClippedLine>
        <ClippedLine dimColor>UD Enter 1/2 Esc</ClippedLine>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text>howto needs an AI provider before it can call AI.</Text>
      <Box height={1}>
        <Text> </Text>
      </Box>
      <Text color="green">? Choose AI provider</Text>
      <Box flexDirection="column" marginTop={1}>
        {providers.map((provider, index) => {
          const isSelected = selectedIndex === index;
          return (
            <Box key={provider}>
              <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "> " : "  "}</Text>
              <Text inverse={isSelected} bold={isSelected}>
                {index + 1}. {provider}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box flexShrink={0} marginTop={1}>
        <Text dimColor>
          Use Up/Down or 1/2 to choose, Enter to continue, Esc or Ctrl+C to cancel.
        </Text>
      </Box>
    </Box>
  );
};

const InputStep: React.FC<{
  state: Extract<InitializationState, { step: "input" }>;
  frameRows: number;
}> = ({ state, frameRows }) => {
  const currentField = state.fields[state.fieldIndex];
  const shortLabel = getShortFieldLabel(currentField);

  if (frameRows < RICH_LAYOUT_MIN_ROWS) {
    const fieldValue = getFieldValuePreview(currentField);
    const fieldLine = `${shortLabel}: ${fieldValue}`;
    const statusLine = state.errorMessage === undefined ? fieldLine : `! ${shortLabel} required`;

    if (frameRows === 1) {
      const compactField =
        state.errorMessage === undefined
          ? `${shortLabel}:${getCompactFieldValuePreview(currentField)}`
          : `!${shortLabel}:req`;
      return (
        <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
          <Box
            flexGrow={1}
            flexShrink={1}
            minWidth={1}
            height={1}
            maxHeight={1}
            overflowX="hidden"
            overflowY="hidden"
          >
            <Text>{compactField}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text dimColor> Ent Esc ^C</Text>
          </Box>
        </Box>
      );
    }

    if (frameRows <= 3) {
      return (
        <Box
          flexDirection="column"
          height={frameRows}
          maxHeight={frameRows}
          overflowX="hidden"
          overflowY="hidden"
        >
          {frameRows === 3 && (
            <ClippedLine color={state.errorMessage === undefined ? "green" : "red"}>
              {state.errorMessage === undefined ? `? Configure ${state.provider}` : statusLine}
            </ClippedLine>
          )}
          {frameRows === 3 || state.errorMessage === undefined ? (
            <ClippedLine prefix={`${shortLabel}:`} prefixWidth={shortLabel.length + 2}>
              {fieldValue}
            </ClippedLine>
          ) : (
            <ClippedLine>{statusLine}</ClippedLine>
          )}
          <Text dimColor>Ent next Esc back ^C</Text>
        </Box>
      );
    }

    const defaultPreview =
      currentField.defaultValue !== undefined && currentField.value === ""
        ? `Default: ${toSingleLinePreview(currentField.defaultValue)}`
        : undefined;
    const guidance = defaultPreview ?? getFullFieldGuidance(currentField);

    return (
      <Box flexDirection="column" maxHeight={4} overflowX="hidden" overflowY="hidden">
        <ClippedLine color={state.errorMessage === undefined ? "green" : "red"}>
          {state.errorMessage === undefined ? `? Configure ${state.provider}` : statusLine}
        </ClippedLine>
        <ClippedLine prefix={`${shortLabel}:`} prefixWidth={shortLabel.length + 2}>
          {fieldValue}
        </ClippedLine>
        {guidance !== undefined && <ClippedLine dimColor>{guidance}</ClippedLine>}
        <ClippedLine dimColor>Ent next Esc back ^C</ClippedLine>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="green">? Configure {state.provider}</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.fields.map((field, index) => (
          <FieldRow key={field.name} field={field} isActive={index === state.fieldIndex} />
        ))}
      </Box>
      {getFullFieldGuidance(currentField) !== undefined && (
        <ClippedLine dimColor>{getFullFieldGuidance(currentField)}</ClippedLine>
      )}
      {currentField.defaultValue !== undefined && currentField.value === "" && (
        <ClippedLine dimColor prefix="Default:" prefixWidth={9}>
          {toSingleLinePreview(currentField.defaultValue)}
        </ClippedLine>
      )}
      {state.errorMessage !== undefined && (
        <ClippedLine color="red">{toSingleLinePreview(state.errorMessage)}</ClippedLine>
      )}
      <Box flexShrink={0} marginTop={1}>
        <Text dimColor>Press Enter for next value, Esc to go back, Ctrl+C to cancel.</Text>
      </Box>
    </Box>
  );
};

const FieldRow: React.FC<{ field: InitializationFieldState; isActive: boolean }> = ({
  field,
  isActive,
}) => {
  const shortLabel = getShortFieldLabel(field);

  return (
    <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
      <Box width={2} flexShrink={0}>
        <Text color={isActive ? "cyan" : undefined}>{isActive ? "> " : "  "}</Text>
      </Box>
      <Box width={shortLabel.length + 2} flexShrink={0}>
        <Text>{shortLabel}:</Text>
      </Box>
      <Box
        flexShrink={1}
        minWidth={1}
        height={1}
        maxHeight={1}
        overflowX="hidden"
        overflowY="hidden"
      >
        <Text>{toSingleLinePreview(field.value)}</Text>
      </Box>
      {isActive && (
        <Box width={1} flexShrink={0}>
          <Text backgroundColor="white"> </Text>
        </Box>
      )}
    </Box>
  );
};

const InitializationStatusLine: React.FC<{
  frameRows: number;
  message: string;
  color?: "green" | "red";
  dimColor?: boolean;
}> = ({ frameRows, message, color, dimColor = false }) => {
  const status = (
    <ClippedLine color={color} dimColor={dimColor}>
      {toSingleLinePreview(message)}
    </ClippedLine>
  );

  if (frameRows < 4) {
    return status;
  }

  return (
    <Box flexDirection="column" marginY={1}>
      {status}
    </Box>
  );
};

function getShortFieldLabel(field: InitializationFieldState): string {
  switch (field.name) {
    case "apiKey":
      return "Key";
    case "model":
      return "Model";
    case "openaiBaseUrl":
      return "URL";
  }
}

function getFullFieldGuidance(field: InitializationFieldState): string | undefined {
  switch (field.name) {
    case "apiKey":
      return field.required ? "Required." : "Optional; empty allowed.";
    case "model":
      return undefined;
    case "openaiBaseUrl":
      return "Empty uses official OpenAI URL.";
  }
}

function getFieldValuePreview(field: InitializationFieldState): string {
  if (field.value !== "") {
    return toSingleLinePreview(field.value);
  }

  if (field.defaultValue !== undefined) {
    return toSingleLinePreview(field.defaultValue);
  }

  return field.required ? "<required>" : "<empty>";
}

function getCompactFieldValuePreview(field: InitializationFieldState): string {
  if (field.value !== "") {
    return toSingleLinePreview(field.value);
  }

  if (field.defaultValue !== undefined) {
    return toSingleLinePreview(field.defaultValue);
  }

  return field.required ? "req" : "-";
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.trim() !== "") {
    return new Error(error);
  }

  return new Error("unknown error");
}
