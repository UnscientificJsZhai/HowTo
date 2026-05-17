import readline from "readline";

import {
  InteractionCancelledError,
  ensureInteractiveTty,
  type InteractiveStreams,
} from "./interactive";
import type { DangerousCommandMatch } from "../safety/dangerous-command";

interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
}

export async function confirmFinalCommand(
  command: string,
  streams: InteractiveStreams = {},
): Promise<void> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  ensureInteractiveTty(input, output);

  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw === true;

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      if (typeof input.setRawMode === "function" && !wasRaw) {
        input.setRawMode(false);
      }
    };

    const finish = (): void => {
      cleanup();
      resolve();
    };

    const cancel = (): void => {
      cleanup();
      reject(new InteractionCancelledError("Final command confirmation cancelled"));
    };

    const onKeypress = (_inputText: string, key: KeypressEvent = {}): void => {
      if (key.ctrl === true && key.name === "c") {
        cancel();
        return;
      }

      if (key.name === "escape") {
        cancel();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        finish();
      }
    };

    output.write(formatFinalCommandConfirmation(command));
    readline.emitKeypressEvents(input as NodeJS.ReadStream);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }
    input.resume();
    input.on("keypress", onKeypress);
  });
}

export async function confirmDangerousCommand(
  command: string,
  match: DangerousCommandMatch,
  streams: InteractiveStreams = {},
): Promise<void> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  ensureInteractiveTty(input, output);

  const rl = readline.createInterface({
    input,
    output,
    terminal: input.isTTY === true && output.isTTY === true,
  });

  try {
    output.write(formatDangerousCommandConfirmation(command, match));
    const answer = await readConfirmationLine(rl, input);

    if (answer !== "EXECUTE") {
      throw new InteractionCancelledError("Dangerous command confirmation cancelled");
    }
  } finally {
    rl.close();
  }
}

export function formatFinalCommandConfirmation(command: string): string {
  return `\nFinal command:\n${command}\n\nPress Enter to execute, Esc or Ctrl+C to cancel.\n`;
}

export function formatDangerousCommandConfirmation(command: string, match: DangerousCommandMatch): string {
  return [
    "\nDangerous command detected.",
    `Rule: ${match.rule}`,
    `Risk: ${match.reason}`,
    "",
    "Final command:",
    command,
    "",
    'Type EXECUTE to continue, or anything else to cancel.',
    "> ",
  ].join("\n");
}

function readConfirmationLine(rl: readline.Interface, input: NodeJS.ReadableStream): Promise<string> {
  input.resume();

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      rl.off("line", onLine);
      rl.off("SIGINT", onSigint);
    };

    const onLine = (line: string): void => {
      cleanup();
      resolve(line);
    };

    const onSigint = (): void => {
      cleanup();
      reject(new InteractionCancelledError("Dangerous command confirmation cancelled"));
    };

    rl.on("line", onLine);
    rl.on("SIGINT", onSigint);
  });
}
