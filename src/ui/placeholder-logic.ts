import type { CommandCandidateContract, CommandPlaceholderContract } from "../ai/types.js";

const PLACEHOLDER_REFERENCE_PATTERN = /{{([^{}]*)}}/g;

export class PlaceholderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderResolutionError";
  }
}

export interface PlaceholderResolutionState {
  candidate: CommandCandidateContract;
  activeIndex: number;
  values: string[];
  buffer: string;
}

export interface ResolvedCommand {
  candidate: CommandCandidateContract;
  values: Map<string, string>;
  command: string;
}

export type PlaceholderResolutionInput =
  { type: "append"; value: string } | { type: "delete" } | { type: "commit" } | { type: "escape" };

export type PlaceholderResolutionTransition =
  | { type: "editing"; state: PlaceholderResolutionState }
  | { type: "back-to-selection" }
  | { type: "complete"; resolved: ResolvedCommand };

export function createPlaceholderResolution(
  candidate: CommandCandidateContract,
): PlaceholderResolutionState {
  if (candidate.placeholders.length === 0) {
    throw new PlaceholderResolutionError("cannot resolve command without placeholders");
  }

  return {
    candidate,
    activeIndex: 0,
    values: candidate.placeholders.map(() => ""),
    buffer: "",
  };
}

export function getPlaceholderResolutionView(state: PlaceholderResolutionState): {
  currentPlaceholder: CommandPlaceholderContract;
  currentBuffer: { name: string; value: string };
  resolvedValues: Map<string, string>;
} {
  const currentPlaceholder = state.candidate.placeholders[state.activeIndex];

  if (!currentPlaceholder) {
    throw new PlaceholderResolutionError("placeholder resolution state is out of bounds");
  }

  const resolvedValues = new Map<string, string>();
  state.candidate.placeholders.forEach((placeholder, index) => {
    if (index < state.activeIndex) {
      resolvedValues.set(placeholder.name, state.values[index]);
    }
  });

  return {
    currentPlaceholder,
    currentBuffer: {
      name: currentPlaceholder.name,
      value: state.buffer,
    },
    resolvedValues,
  };
}

export function applyPlaceholderResolutionInput(
  state: PlaceholderResolutionState,
  input: PlaceholderResolutionInput,
): PlaceholderResolutionTransition {
  switch (input.type) {
    case "append":
      return {
        type: "editing",
        state: {
          ...state,
          buffer: state.buffer + input.value,
        },
      };

    case "delete":
      return {
        type: "editing",
        state: {
          ...state,
          buffer: state.buffer.slice(0, -1),
        },
      };

    case "escape":
      return applyEscape(state);

    case "commit":
      return applyCommit(state);
  }
}

export function resolveCandidatePlaceholders(
  candidate: CommandCandidateContract,
  values: Map<string, string>,
): ResolvedCommand {
  const command = replaceCommandPlaceholders(candidate.command, values);

  return {
    candidate,
    values,
    command,
  };
}

export function replaceCommandPlaceholders(command: string, values: Map<string, string>): string {
  return command.replace(PLACEHOLDER_REFERENCE_PATTERN, (_reference, name: string) => {
    if (!values.has(name)) {
      throw new PlaceholderResolutionError("final command contains unresolved placeholders");
    }

    return values.get(name) ?? "";
  });
}

function applyEscape(state: PlaceholderResolutionState): PlaceholderResolutionTransition {
  if (state.activeIndex === 0) {
    return { type: "back-to-selection" };
  }

  const previousIndex = state.activeIndex - 1;
  const values = [...state.values];
  values[state.activeIndex] = "";

  return {
    type: "editing",
    state: {
      ...state,
      activeIndex: previousIndex,
      values,
      buffer: values[previousIndex],
    },
  };
}

function applyCommit(state: PlaceholderResolutionState): PlaceholderResolutionTransition {
  const values = [...state.values];
  values[state.activeIndex] = state.buffer;

  if (state.activeIndex === state.candidate.placeholders.length - 1) {
    const resolvedValues = new Map<string, string>();
    state.candidate.placeholders.forEach((placeholder, index) => {
      resolvedValues.set(placeholder.name, values[index]);
    });

    return {
      type: "complete",
      resolved: resolveCandidatePlaceholders(state.candidate, resolvedValues),
    };
  }

  const nextIndex = state.activeIndex + 1;

  return {
    type: "editing",
    state: {
      ...state,
      activeIndex: nextIndex,
      values,
      buffer: values[nextIndex],
    },
  };
}
