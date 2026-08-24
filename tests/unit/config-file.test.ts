import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";

import { ConfigError } from "../../src/config.js";
import {
  getConfigFilePath,
  readUserConfigFile,
  writeUserConfigFile,
} from "../../src/config-file.js";
import { createFileConfig } from "../../src/init/index.js";

async function tempConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "howto-config-test-"));
  return join(dir, ".howto", "config.json");
}

async function writeRawConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("readUserConfigFile treats a missing file as empty config", async () => {
  assert.deepEqual(await readUserConfigFile(await tempConfigPath()), {});
});

test("getConfigFilePath treats missing and blank HOME as absent", () => {
  const expectedPath = join(homedir(), ".howto", "config.json");

  for (const env of [{}, { HOME: "" }, { HOME: "   " }, { HOME: "\t" }]) {
    const path = getConfigFilePath(env);
    assert.equal(path, expectedPath);
    assert.equal(isAbsolute(dirname(path)), true);
  }
});

test("getConfigFilePath accepts an absolute HOME and rejects a relative HOME", async () => {
  const absoluteHome = await mkdtemp(join(tmpdir(), "howto-home-test-"));

  assert.equal(
    getConfigFilePath({ HOME: absoluteHome }),
    join(absoluteHome, ".howto", "config.json"),
  );
  assert.throws(() => getConfigFilePath({ HOME: "relative-home" }), ConfigError);
});

test("writeUserConfigFile rejects a relative directory before creating it", async () => {
  const relativeHome = `howto-relative-home-${process.pid}-${Date.now()}`;
  const relativePath = join(relativeHome, ".howto", "config.json");

  assert.equal(existsSync(relativeHome), false);
  await assert.rejects(
    () => writeUserConfigFile({ aiProvider: "openai" }, relativePath),
    ConfigError,
  );
  assert.equal(existsSync(relativeHome), false);
});

test("readUserConfigFile reads known string fields and ignores unknown fields", async () => {
  const path = await tempConfigPath();
  await writeUserConfigFile(
    {
      aiProvider: "openai",
      openaiModel: "file-model",
    },
    path,
  );
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  raw.unknownField = "ignored";
  await writeFile(path, `${JSON.stringify(raw)}\n`, "utf8");

  assert.deepEqual(await readUserConfigFile(path), {
    aiProvider: "openai",
    openaiModel: "file-model",
  });
});

test("readUserConfigFile accepts structuredOutput boolean and string values", async () => {
  const booleanPath = await tempConfigPath();
  await writeRawConfig(booleanPath, '{"aiProvider":"openai","structuredOutput":false}');
  assert.deepEqual(await readUserConfigFile(booleanPath), {
    aiProvider: "openai",
    structuredOutput: false,
  });

  const stringPath = await tempConfigPath();
  await writeRawConfig(stringPath, '{"aiProvider":"openai","structuredOutput":"true"}');
  assert.deepEqual(await readUserConfigFile(stringPath), {
    aiProvider: "openai",
    structuredOutput: "true",
  });
});

test("readUserConfigFile rejects non-boolean non-string structuredOutput", async () => {
  const path = await tempConfigPath();
  await writeRawConfig(path, '{"structuredOutput":1}');
  await assert.rejects(() => readUserConfigFile(path), ConfigError);
});

test("createFileConfig does not write structuredOutput by default", () => {
  assert.equal(
    "structuredOutput" in createFileConfig({ provider: "openai", apiKey: "", model: "gpt" }),
    false,
  );
  assert.equal(
    "structuredOutput" in
      createFileConfig({ provider: "gemini", apiKey: "gemini-key", model: "gemini-model" }),
    false,
  );
});

test("readUserConfigFile uses fixed messages for read, JSON, and root failures", async () => {
  const unreadablePath = await tempConfigPath();
  await mkdir(unreadablePath, { recursive: true });
  await assert.rejects(
    () => readUserConfigFile(unreadablePath),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "failed to read user config file",
  );

  const invalidJsonPath = await tempConfigPath();
  await writeRawConfig(invalidJsonPath, "{");
  await assert.rejects(
    () => readUserConfigFile(invalidJsonPath),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "user config file is not valid JSON",
  );

  const arrayPath = await tempConfigPath();
  await writeRawConfig(arrayPath, "[]");
  await assert.rejects(
    () => readUserConfigFile(arrayPath),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "user config file must contain a JSON object",
  );
});

test("readUserConfigFile rejects invalid known field types", async () => {
  const invalidFieldPath = await tempConfigPath();
  await writeRawConfig(invalidFieldPath, '{"aiProvider":42}');

  await assert.rejects(() => readUserConfigFile(invalidFieldPath), ConfigError);
});

test("writeUserConfigFile creates and fully overwrites config file", async () => {
  const path = await tempConfigPath();

  await writeUserConfigFile(
    { aiProvider: "gemini", geminiApiKey: "key", geminiModel: "model" },
    path,
  );
  await writeUserConfigFile({ aiProvider: "openai", openaiApiKey: "", openaiModel: "gpt" }, path);

  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
    aiProvider: "openai",
    openaiApiKey: "",
    openaiModel: "gpt",
  });
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
});

test("writeUserConfigFile cleans temporary data when atomic replacement fails", async () => {
  const path = await tempConfigPath();
  await mkdir(path, { recursive: true });

  await assert.rejects(
    () =>
      writeUserConfigFile(
        { aiProvider: "gemini", geminiApiKey: "temporary-secret", geminiModel: "model" },
        path,
      ),
    ConfigError,
  );

  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
  assert.deepEqual(await readdir(path), []);
});

test("writeUserConfigFile maps config directory creation failures to a fixed error", async (t) => {
  const parentDirectory = await mkdtemp(join(tmpdir(), "howto-config-parent-file-test-"));
  t.after(() => rm(parentDirectory, { recursive: true, force: true }));
  const blockingFile = join(parentDirectory, "not-a-directory");
  await writeFile(blockingFile, "blocking file", "utf8");

  await assert.rejects(
    () => writeUserConfigFile({ aiProvider: "openai" }, join(blockingFile, "config.json")),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "failed to save user config file",
  );
});

test("createFileConfig writes only selected provider fields", () => {
  assert.deepEqual(
    createFileConfig({
      provider: "gemini",
      apiKey: "gemini-key",
      model: "gemini-model",
    }),
    {
      aiProvider: "gemini",
      geminiApiKey: "gemini-key",
      geminiModel: "gemini-model",
    },
  );

  assert.deepEqual(
    createFileConfig({
      provider: "openai",
      apiKey: "openai-key",
      model: "openai-model",
      openaiBaseUrl: "https://local.example/v1",
    }),
    {
      aiProvider: "openai",
      openaiApiKey: "openai-key",
      openaiModel: "openai-model",
      openaiApiUrl: "https://local.example/v1",
    },
  );
});
