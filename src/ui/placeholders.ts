import readline from "readline";

import type { CommandCandidateContract, CommandPlaceholderContract } from "../ai/types";
import {
  InteractionCancelledError,
  type InteractiveInput,
  type InteractiveOutput,
  type InteractiveStreams,
} from "./interactive";

export class PlaceholderResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceholderResolutionError";
  }
}

const UNRESOLVED_PLACEHOLDER_PATTERN = /{{[^{}]*}}/;

export async function resolveCommandPlaceholders(
  candidate: CommandCandidateContract,
  streams: InteractiveStreams = {},
): Promise<string> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const values = await promptPlaceholderValues(candidate.placeholders, { input, output });
  const command = replaceCommandPlaceholders(candidate.command, values);

  assertNoUnresolvedPlaceholders(command);

  return command;
}

export async function promptPlaceholderValues(
  placeholders: CommandPlaceholderContract[],
  streams: Required<InteractiveStreams>,
): Promise<Map<string, string>> {
  const values = new Map<string, string>();

  if (placeholders.length === 0) {
    return values;
  }

  const rl = readline.createInterface({
    input: streams.input,
    output: streams.output,
    terminal: streams.input.isTTY === true && streams.output.isTTY === true,
  });
  streams.input.resume();
  const lineReader = createLineReader(rl);

  try {
    for (const placeholder of placeholders) {
      streams.output.write(`\n${placeholder.name}: ${placeholder.description}\n> `);
      const value = await lineReader.readLine();
      values.set(placeholder.name, value);
    }
  } finally {
    lineReader.dispose();
    rl.close();
  }

  return values;
}

export function replaceCommandPlaceholders(command: string, values: Map<string, string>): string {
  let resolvedCommand = command;

  for (const [name, value] of values) {
    resolvedCommand = resolvedCommand.split(`{{${name}}}`).join(value);
  }

  return resolvedCommand;
}

export function assertNoUnresolvedPlaceholders(command: string): void {
  if (UNRESOLVED_PLACEHOLDER_PATTERN.test(command)) {
    throw new PlaceholderResolutionError("final command contains unresolved placeholders");
  }
}

function createLineReader(rl: readline.Interface): {
  readLine(): Promise<string>;
  dispose(): void;
} {
  const queuedLines: string[] = [];
  let waiting:
    | {
        resolve(value: string): void;
        reject(error: Error): void;
      }
    | undefined;

  const onLine = (line: string): void => {
    if (waiting === undefined) {
      queuedLines.push(line);
      return;
    }

    const current = waiting;
    waiting = undefined;
    current.resolve(line);
  };

  const onSigint = (): void => {
    if (waiting !== undefined) {
      const current = waiting;
      waiting = undefined;
      current.reject(new InteractionCancelledError("Placeholder input cancelled"));
    }
  };

  rl.on("line", onLine);
  rl.on("SIGINT", onSigint);

  return {
    readLine(): Promise<string> {
      const nextLine = queuedLines.shift();

      if (nextLine !== undefined) {
        return Promise.resolve(nextLine);
      }

      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    dispose(): void {
      rl.off("line", onLine);
      rl.off("SIGINT", onSigint);
      if (waiting !== undefined) {
        const current = waiting;
        waiting = undefined;
        current.reject(new InteractionCancelledError("Placeholder input cancelled"));
      }
    },
  };
}

export type { InteractiveInput, InteractiveOutput };
