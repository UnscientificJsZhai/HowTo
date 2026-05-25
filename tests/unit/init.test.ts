import assert from "node:assert/strict";
import test from "node:test";

import {
  countTerminalRows,
  clearInitializationOutput,
  createFileConfig,
  erasePreviousTerminalRows,
} from "../../src/init/index.js";
import {
  applyInitializationInput,
  createInitialInitializationState,
  type InitializationKeyInput,
} from "../../src/init/state.js";
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL } from "../../src/config.js";

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

test("provider selection starts without an implicit selected provider", () => {
  const initialState = createInitialInitializationState();

  const update = applyInitializationInput(initialState, keypress("", { return: true }));

  assert.deepEqual(update, { state: initialState });
});

test("OpenAI initialization accepts an empty API key and default model", () => {
  let update = applyInitializationInput(createInitialInitializationState(), keypress("1"));
  update = applyInitializationInput(update.state, keypress("", { return: true }));
  update = applyInitializationInput(update.state, keypress("", { return: true }));
  update = applyInitializationInput(update.state, keypress("", { return: true }));

  assert.deepEqual(update.completedValues, {
    provider: "openai",
    apiKey: "",
    model: DEFAULT_OPENAI_MODEL,
    openaiBaseUrl: undefined,
  });
});

test("Gemini initialization rejects an empty API key", () => {
  let update = applyInitializationInput(createInitialInitializationState(), keypress("2"));
  update = applyInitializationInput(update.state, keypress("", { return: true }));

  assert.equal(update.state.step, "input");
  assert.equal(update.completedValues, undefined);
  assert.equal(update.state.step === "input" ? update.state.fieldIndex : -1, 0);
  assert.equal(
    update.state.step === "input" ? update.state.errorMessage : undefined,
    "This value is required.",
  );
});

test("Gemini initialization uses the default model when model input is empty", () => {
  let state = applyInitializationInput(createInitialInitializationState(), keypress("2")).state;
  for (const char of "gemini-key") {
    state = applyInitializationInput(state, keypress(char)).state;
  }

  state = applyInitializationInput(state, keypress("", { return: true })).state;
  const update = applyInitializationInput(state, keypress("", { return: true }));

  assert.deepEqual(update.completedValues, {
    provider: "gemini",
    apiKey: "gemini-key",
    model: DEFAULT_GEMINI_MODEL,
  });
});

test("OpenAI empty base URL is not written to file config", () => {
  const fileConfig = createFileConfig({
    provider: "openai",
    apiKey: "",
    model: DEFAULT_OPENAI_MODEL,
    openaiBaseUrl: "",
  });

  assert.deepEqual(fileConfig, {
    aiProvider: "openai",
    openaiApiKey: "",
    openaiModel: DEFAULT_OPENAI_MODEL,
  });
});

test("input step escape returns to provider selection", () => {
  const state = applyInitializationInput(createInitialInitializationState(), keypress("1")).state;
  const update = applyInitializationInput(state, keypress("", { escape: true }));

  assert.deepEqual(update.state, createInitialInitializationState());
});

test("Ctrl+C cancels initialization", () => {
  const update = applyInitializationInput(
    createInitialInitializationState(),
    keypress("c", { ctrl: true }),
  );

  assert.equal(update.cancelled, true);
});

function keypress(
  input: string,
  key: Partial<InitializationKeyInput["key"]> = {},
): InitializationKeyInput {
  return {
    input,
    key: {
      upArrow: false,
      downArrow: false,
      return: false,
      escape: false,
      ctrl: false,
      backspace: false,
      delete: false,
      ...key,
    },
  };
}
