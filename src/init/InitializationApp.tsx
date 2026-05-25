import React, { useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { AppConfig } from "../config.js";
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

export const InitializationApp: React.FC<Props> = ({ onSubmit, onComplete, onCancel, onError }) => {
  const [state, setState] = useState<InitializationState>(createInitialInitializationState);
  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("editing");
  const [errorMessage, setErrorMessage] = useState("");

  useInput(
    (input: string, key: Key) => {
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
    { isActive: submitStatus === "editing" },
  );

  if (submitStatus === "saving") {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color="green">Saving howto configuration...</Text>
      </Box>
    );
  }

  if (submitStatus === "error") {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color="red">Error: {errorMessage}</Text>
      </Box>
    );
  }

  if (submitStatus === "cancelled") {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text dimColor>Initialization cancelled.</Text>
      </Box>
    );
  }

  if (state.step === "provider") {
    return <ProviderStep selectedIndex={state.selectedIndex} />;
  }

  return <InputStep state={state} />;
};

const ProviderStep: React.FC<{ selectedIndex: number | null }> = ({ selectedIndex }) => {
  const providers = getProviderOptions();

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

const InputStep: React.FC<{ state: Extract<InitializationState, { step: "input" }> }> = ({
  state,
}) => {
  const currentField = state.fields[state.fieldIndex];

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="green">? Configure {state.provider}</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.fields.map((field, index) => (
          <FieldRow key={field.name} field={field} isActive={index === state.fieldIndex} />
        ))}
      </Box>
      {currentField.defaultValue !== undefined && currentField.value === "" && (
        <Text dimColor>Default: {currentField.defaultValue}</Text>
      )}
      {state.errorMessage !== undefined && <Text color="red">{state.errorMessage}</Text>}
      <Box flexShrink={0} marginTop={1}>
        <Text dimColor>Press Enter for next value, Esc to go back, Ctrl+C to cancel.</Text>
      </Box>
    </Box>
  );
};

const FieldRow: React.FC<{ field: InitializationFieldState; isActive: boolean }> = ({
  field,
  isActive,
}) => (
  <Box>
    <Text color={isActive ? "cyan" : undefined}>{isActive ? "> " : "  "}</Text>
    <Text>{field.label}: </Text>
    <Text>{field.value}</Text>
    {isActive && <Text backgroundColor="white"> </Text>}
  </Box>
);

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.trim() !== "") {
    return new Error(error);
  }

  return new Error("unknown error");
}
