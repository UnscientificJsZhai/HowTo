import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  countTerminalRows,
  clearInitializationOutput,
  createFileConfig,
  erasePreviousTerminalRows,
  validateAndPersistInitializationConfig,
} from "../../src/init/index.js";
import {
  applyInitializationInput,
  createInitialInitializationState,
  type InitializationKeyInput,
} from "../../src/init/state.js";
import { ConfigError, DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL } from "../../src/config.js";

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

test("initialization drops a whole input chunk containing any forbidden terminal control", () => {
  const initialInputState = applyInitializationInput(
    createInitialInitializationState(),
    keypress("1"),
  ).state;

  for (const codeUnit of unsafeTerminalCodeUnits()) {
    const attack = `safe-prefix${String.fromCharCode(codeUnit)}safe-suffix`;
    const update = applyInitializationInput(initialInputState, keypress(attack));

    assert.equal(update.state.step, "input");
    assert.equal(
      update.state.step === "input" ? update.state.fields[0]?.value : undefined,
      "",
      `expected U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")} to reject the chunk`,
    );
  }
});

test("initialization accepts ordinary and CR/LF paste values", () => {
  const initialInputState = applyInitializationInput(
    createInitialInitializationState(),
    keypress("1"),
  ).state;
  const pastedValue = "ordinary\r\nvalue";
  const update = applyInitializationInput(initialInputState, keypress(pastedValue));

  assert.equal(update.state.step, "input");
  assert.equal(
    update.state.step === "input" ? update.state.fields[0]?.value : undefined,
    pastedValue,
  );
});

test("initialization keeps standalone Backspace and Delete behavior", () => {
  let state = applyInitializationInput(createInitialInitializationState(), keypress("1")).state;
  state = applyInitializationInput(state, keypress("ab")).state;
  state = applyInitializationInput(state, keypress("", { backspace: true })).state;
  state = applyInitializationInput(state, keypress("c")).state;
  state = applyInitializationInput(state, keypress("", { delete: true })).state;

  assert.equal(state.step, "input");
  assert.equal(state.step === "input" ? state.fields[0]?.value : undefined, "a");
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

test("initialization validation failure preserves the existing config byte for byte", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-init-transaction-test-"));
  const configPath = join(homeDirectory, ".howto", "config.json");
  const originalConfig = '{"aiProvider":"gemini","geminiApiKey":"existing-secret"}\n';
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, originalConfig, "utf8");

  await assert.rejects(
    () =>
      validateAndPersistInitializationConfig(
        { provider: "openai", apiKey: "new-secret", model: "openai-model" },
        { print: false, aiProvider: "gemini" },
        { HOME: homeDirectory },
      ),
    ConfigError,
  );

  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.deepEqual(await readdir(dirname(configPath)), ["config.json"]);
});

test("initialization returns merged overrides but persists only submitted provider fields", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-init-override-test-"));

  const config = await validateAndPersistInitializationConfig(
    {
      provider: "openai",
      apiKey: "submitted-openai-secret",
      model: "submitted-openai-model",
      openaiBaseUrl: "https://submitted.example/v1",
    },
    { print: false, aiProvider: "gemini" },
    {
      HOME: homeDirectory,
      HOWTO_GEMINI_API_KEY: "environment-gemini-secret",
      HOWTO_GEMINI_MODEL: "environment-gemini-model",
      HOWTO_STRUCTURED_OUTPUT: "false",
    },
  );

  assert.deepEqual(config, {
    aiProvider: "gemini",
    gemini: {
      apiKey: "environment-gemini-secret",
      model: "environment-gemini-model",
    },
    openai: {
      apiKey: "submitted-openai-secret",
      model: "submitted-openai-model",
      baseUrl: "https://submitted.example/v1",
    },
    structuredOutput: false,
  });
  assert.deepEqual(
    JSON.parse(await readFile(join(homeDirectory, ".howto", "config.json"), "utf8")),
    {
      aiProvider: "openai",
      openaiApiKey: "submitted-openai-secret",
      openaiModel: "submitted-openai-model",
      openaiApiUrl: "https://submitted.example/v1",
    },
  );
  assert.deepEqual(await readdir(join(homeDirectory, ".howto")), ["config.json"]);
});

test("initialization rejects a relative HOME without creating a repository config directory", async () => {
  const relativeHome = `howto-relative-init-${process.pid}-${Date.now()}`;

  assert.equal(existsSync(relativeHome), false);
  await assert.rejects(
    () =>
      validateAndPersistInitializationConfig(
        { provider: "openai", apiKey: "new-secret", model: "openai-model" },
        { print: false },
        { HOME: relativeHome },
      ),
    ConfigError,
  );
  assert.equal(existsSync(relativeHome), false);
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

function unsafeTerminalCodeUnits(): number[] {
  return [...range(0x00, 0x09), ...range(0x0b, 0x0c), ...range(0x0e, 0x1f), ...range(0x7f, 0x9f)];
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
