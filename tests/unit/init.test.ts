import assert from "node:assert/strict";
import test from "node:test";

import {
  countInitializationPromptRows,
  countTerminalRows,
  clearInitializationOutput,
  erasePreviousTerminalRows,
} from "../../src/init/index.js";

test("initialization output clear erases the requested rows without clearing the full screen", () => {
  let output = "";
  const stdout = {
    isTTY: true,
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as NodeJS.WriteStream;

  clearInitializationOutput(stdout, 3);

  assert.equal(output, "\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[1A\x1b[2K\x1b[G");
});

test("initialization output clear does not write control codes outside a TTY", () => {
  let output = "";
  const stdout = {
    isTTY: false,
    write(chunk: string) {
      output += chunk;
      return true;
    },
  } as NodeJS.WriteStream;

  clearInitializationOutput(stdout, 3);

  assert.equal(output, "");
});

test("erasePreviousTerminalRows handles empty row counts", () => {
  assert.equal(erasePreviousTerminalRows(0), "");
});

test("countTerminalRows accounts for explicit newlines and wrapping", () => {
  const stdout = {
    isTTY: true,
    columns: 10,
  } as NodeJS.WriteStream;

  assert.equal(countTerminalRows(stdout, "12345678901\n\nabc\n"), 4);
});

test("countInitializationPromptRows counts the completed provider prompts", () => {
  const stdout = {
    isTTY: true,
    columns: 80,
  } as NodeJS.WriteStream;

  assert.equal(
    countInitializationPromptRows(stdout, {
      provider: "openai",
      apiKey: "",
      model: "gpt-5.4-mini",
    }),
    4,
  );

  assert.equal(
    countInitializationPromptRows(stdout, {
      provider: "gemini",
      apiKey: "key",
      model: "gemini-3.1-flash-lite",
    }),
    3,
  );
});
