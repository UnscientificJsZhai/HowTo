import type { Key } from "ink";
import type { AiProvider } from "../config.js";
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL } from "../config.js";
import type { InitializationValues } from "./index.js";

export interface InitializationKeyInput {
  input: string;
  key: Pick<Key, "upArrow" | "downArrow" | "return" | "escape" | "ctrl" | "backspace" | "delete">;
}

export interface ProviderSelectionState {
  step: "provider";
  selectedIndex: number | null;
}

export type InitializationFieldName = "apiKey" | "model" | "openaiBaseUrl";

export interface InitializationFieldState {
  name: InitializationFieldName;
  label: string;
  value: string;
  defaultValue?: string;
  required: boolean;
}

export interface InitializationInputState {
  step: "input";
  provider: AiProvider;
  fieldIndex: number;
  fields: InitializationFieldState[];
  errorMessage?: string;
}

export type InitializationState = ProviderSelectionState | InitializationInputState;

export interface InitializationUpdate {
  state: InitializationState;
  completedValues?: InitializationValues;
  cancelled?: boolean;
}

const PROVIDERS: readonly AiProvider[] = ["openai", "gemini"];

export function createInitialInitializationState(): InitializationState {
  return {
    step: "provider",
    selectedIndex: null,
  };
}

export function getProviderOptions(): readonly AiProvider[] {
  return PROVIDERS;
}

export function applyInitializationInput(
  state: InitializationState,
  event: InitializationKeyInput,
): InitializationUpdate {
  if (event.key.ctrl && event.input === "c") {
    return { state, cancelled: true };
  }

  if (state.step === "provider") {
    return applyProviderInput(state, event);
  }

  return applyFieldInput(state, event);
}

function applyProviderInput(
  state: ProviderSelectionState,
  event: InitializationKeyInput,
): InitializationUpdate {
  if (event.key.escape) {
    return { state, cancelled: true };
  }

  const numericSelection = getNumericProviderSelection(event.input);
  if (numericSelection !== null) {
    return {
      state: createInputState(PROVIDERS[numericSelection]),
    };
  }

  if (event.key.upArrow) {
    return {
      state: {
        ...state,
        selectedIndex:
          state.selectedIndex === null
            ? PROVIDERS.length - 1
            : (state.selectedIndex - 1 + PROVIDERS.length) % PROVIDERS.length,
      },
    };
  }

  if (event.key.downArrow) {
    return {
      state: {
        ...state,
        selectedIndex:
          state.selectedIndex === null ? 0 : (state.selectedIndex + 1) % PROVIDERS.length,
      },
    };
  }

  if (event.key.return && state.selectedIndex !== null) {
    return {
      state: createInputState(PROVIDERS[state.selectedIndex]),
    };
  }

  return { state };
}

function getNumericProviderSelection(input: string): number | null {
  if (input === "1") {
    return 0;
  }

  if (input === "2") {
    return 1;
  }

  return null;
}

function applyFieldInput(
  state: InitializationInputState,
  event: InitializationKeyInput,
): InitializationUpdate {
  if (event.key.escape) {
    return { state: createInitialInitializationState() };
  }

  if (event.key.return) {
    const validationError = validateCurrentField(state);
    if (validationError !== undefined) {
      return {
        state: {
          ...state,
          errorMessage: validationError,
        },
      };
    }

    if (state.fieldIndex === state.fields.length - 1) {
      return {
        state,
        completedValues: createInitializationValues(state),
      };
    }

    return {
      state: {
        ...state,
        fieldIndex: state.fieldIndex + 1,
        errorMessage: undefined,
      },
    };
  }

  if (event.key.backspace || event.key.delete) {
    return updateCurrentField(state, (value) => value.slice(0, -1));
  }

  if (event.input !== "" && !hasControlKey(event)) {
    return updateCurrentField(state, (value) => value + event.input);
  }

  return { state };
}

function hasControlKey(event: InitializationKeyInput): boolean {
  return (
    event.key.upArrow ||
    event.key.downArrow ||
    event.key.return ||
    event.key.escape ||
    event.key.ctrl ||
    event.key.backspace ||
    event.key.delete
  );
}

function createInputState(provider: AiProvider): InitializationInputState {
  return {
    step: "input",
    provider,
    fieldIndex: 0,
    fields:
      provider === "gemini"
        ? [
            {
              name: "apiKey",
              label: "Gemini API key",
              value: "",
              required: true,
            },
            {
              name: "model",
              label: "Gemini model",
              value: "",
              defaultValue: DEFAULT_GEMINI_MODEL,
              required: false,
            },
          ]
        : [
            {
              name: "apiKey",
              label: "OpenAI API key (optional)",
              value: "",
              required: false,
            },
            {
              name: "model",
              label: "OpenAI model",
              value: "",
              defaultValue: DEFAULT_OPENAI_MODEL,
              required: false,
            },
            {
              name: "openaiBaseUrl",
              label: "OpenAI base URL (optional, Enter for official default)",
              value: "",
              required: false,
            },
          ],
  };
}

function updateCurrentField(
  state: InitializationInputState,
  updateValue: (value: string) => string,
): InitializationUpdate {
  return {
    state: {
      ...state,
      fields: state.fields.map((field, index) =>
        index === state.fieldIndex
          ? {
              ...field,
              value: updateValue(field.value),
            }
          : field,
      ),
      errorMessage: undefined,
    },
  };
}

function validateCurrentField(state: InitializationInputState): string | undefined {
  const field = state.fields[state.fieldIndex];
  if (field.required && field.value.trim() === "") {
    return "This value is required.";
  }

  return undefined;
}

function createInitializationValues(state: InitializationInputState): InitializationValues {
  const fieldValues = new Map(state.fields.map((field) => [field.name, field.value]));
  const modelValue = fieldValues.get("model")?.trim();

  if (state.provider === "gemini") {
    return {
      provider: "gemini",
      apiKey: fieldValues.get("apiKey") ?? "",
      model: modelValue === "" || modelValue === undefined ? DEFAULT_GEMINI_MODEL : modelValue,
    };
  }

  const baseUrl = fieldValues.get("openaiBaseUrl");

  return {
    provider: "openai",
    apiKey: fieldValues.get("apiKey") ?? "",
    model: modelValue === "" || modelValue === undefined ? DEFAULT_OPENAI_MODEL : modelValue,
    openaiBaseUrl: baseUrl === undefined || baseUrl.trim() === "" ? undefined : baseUrl,
  };
}
