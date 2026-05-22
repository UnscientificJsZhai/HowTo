import assert from "node:assert/strict";
import test from "node:test";

import { clearTerminalOutput } from "../../src/index.js";

test("clearTerminalOutput clears the visible TTY screen and moves to the top-left", () => {
  let output = "";
  const stdout = {
    isTTY: true,
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as NodeJS.WriteStream;

  clearTerminalOutput(stdout);

  assert.equal(output, "\x1b[2J\x1b[H");
});

test("clearTerminalOutput does not write when stdout is not a TTY", () => {
  let output = "";
  const stdout = {
    isTTY: false,
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as NodeJS.WriteStream;

  clearTerminalOutput(stdout);

  assert.equal(output, "");
});
