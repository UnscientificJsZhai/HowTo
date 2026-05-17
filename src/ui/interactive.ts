import readline from "readline";

import type { CommandCandidateContract } from "../ai/types";

export class InteractiveTtyError extends Error {
  constructor(message = "Interactive mode requires a TTY. Run howto in an interactive terminal or use --print.") {
    super(message);
    this.name = "InteractiveTtyError";
  }
}

export class InteractionCancelledError extends Error {
  constructor(message = "Interactive selection cancelled") {
    super(message);
    this.name = "InteractionCancelledError";
  }
}

export interface InteractiveInput extends NodeJS.ReadableStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): this;
  resume(): this;
}

export interface InteractiveOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
}

export interface InteractiveStreams {
  input?: InteractiveInput;
  output?: InteractiveOutput;
}

interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
}

export async function selectCommandCandidate(
  candidates: CommandCandidateContract[],
  streams: InteractiveStreams = {},
): Promise<CommandCandidateContract> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;

  ensureInteractiveTty(input, output);

  return new Promise((resolve, reject) => {
    let activeIndex = 0;
    let renderedLineCount = 0;
    const wasRaw = input.isRaw === true;

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      if (typeof input.setRawMode === "function" && !wasRaw) {
        input.setRawMode(false);
      }
      output.write("\x1B[?25h");
    };

    const finish = (candidate: CommandCandidateContract): void => {
      cleanup();
      resolve(candidate);
    };

    const cancel = (): void => {
      cleanup();
      reject(new InteractionCancelledError());
    };

    const render = (): void => {
      const text = formatCandidateSelection(candidates, activeIndex);

      if (renderedLineCount > 0) {
        output.write(`\x1B[${renderedLineCount}A\x1B[J`);
      }

      output.write(`\x1B[?25l${text}\n`);
      renderedLineCount = text.split("\n").length + 1;
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
        finish(candidates[activeIndex]);
        return;
      }

      if (key.name === "up") {
        activeIndex = (activeIndex - 1 + candidates.length) % candidates.length;
        render();
        return;
      }

      if (key.name === "down") {
        activeIndex = (activeIndex + 1) % candidates.length;
        render();
      }
    };

    readline.emitKeypressEvents(input as NodeJS.ReadStream);
    if (typeof input.setRawMode === "function") {
      input.setRawMode(true);
    }
    input.resume();
    input.on("keypress", onKeypress);
    render();
  });
}

export function ensureInteractiveTty(input: InteractiveInput, output: InteractiveOutput): void {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new InteractiveTtyError();
  }
}

export function formatCandidateSelection(
  candidates: CommandCandidateContract[],
  activeIndex: number,
): string {
  const lines = ["? Select a command", ""];

  candidates.forEach((candidate, index) => {
    const prefix = index === activeIndex ? ">" : " ";
    lines.push(`${prefix} ${candidate.title}`);
    lines.push(`  ${candidate.command}`);
    lines.push(`  ${candidate.description}`);

    if (index < candidates.length - 1) {
      lines.push("");
    }
  });

  lines.push("");
  lines.push("Use Up/Down to move, Enter to select, Esc or Ctrl+C to cancel.");

  return lines.join("\n");
}
