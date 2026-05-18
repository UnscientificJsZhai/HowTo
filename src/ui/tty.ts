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
  pause(): this;
  resume(): this;
}

export interface InteractiveOutput extends NodeJS.WritableStream {
  isTTY?: boolean;
}

export function ensureInteractiveTty(input: InteractiveInput, output: InteractiveOutput): void {
  if (input.isTTY !== true || output.isTTY !== true) {
    throw new InteractiveTtyError();
  }
}
