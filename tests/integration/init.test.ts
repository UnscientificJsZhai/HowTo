import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { validateAndPersistInitializationConfig } from "../../src/init/index.js";
import { ConfigError } from "../../src/config.js";

test("initialization validation failure preserves the existing config byte for byte", async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-init-transaction-test-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const configPath = join(homeDirectory, ".howto", "config.json");
  const originalConfig = '{"aiProvider":"gemini","geminiApiKey":"existing-secret"}\n';
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, originalConfig, "utf8");

  await assert.rejects(
    () =>
      validateAndPersistInitializationConfig(
        { provider: "openai", apiKey: "new-secret", model: "openai-model" },
        { print: false, structuredOutput: "invalid" },
        { HOME: homeDirectory },
      ),
    ConfigError,
  );

  assert.equal(await readFile(configPath, "utf8"), originalConfig);
  assert.deepEqual(await readdir(dirname(configPath)), ["config.json"]);
});

test("initialization returns merged overrides but persists only submitted provider fields", async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-init-override-test-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));

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
    chatgpt: { account: undefined, model: undefined, fast: true, timings: false },
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

test("ChatGPT 初始化保存选择并保留两个 API provider 与输出设置，覆盖不落盘", async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-chatgpt-init-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const configPath = join(homeDirectory, ".howto", "config.json");
  const previous = {
    aiProvider: "openai",
    openaiApiKey: "saved-openai-key",
    openaiModel: "saved-openai-model",
    openaiApiUrl: "https://saved.example/v1",
    geminiApiKey: "saved-gemini-key",
    geminiModel: "saved-gemini-model",
    chatgptAccount: "previous-account",
    chatgptModel: "previous-model",
    structuredOutput: false,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(previous));
  const config = await validateAndPersistInitializationConfig(
    { provider: "chatgpt", account: "selected-account", model: "selected-model" },
    {
      print: false,
      chatgptAccount: "cli-account",
      chatgptModel: "cli-model",
      openaiApiKey: "cli-key",
      structuredOutput: "true",
    },
    { HOME: homeDirectory, HOWTO_GEMINI_API_KEY: "env-key" },
  );
  assert.deepEqual(config.chatgpt, {
    account: "cli-account",
    model: "cli-model",
    fast: true,
    timings: false,
  });
  assert.equal(config.openai.apiKey, "cli-key");
  assert.equal(config.gemini.apiKey, "env-key");
  assert.equal(config.structuredOutput, true);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    ...previous,
    aiProvider: "chatgpt",
    chatgptAccount: "selected-account",
    chatgptModel: "selected-model",
  });
});

test("重新初始化 API provider 保留 ChatGPT 选择并删除显式清空的旧 URL", async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-api-init-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const configPath = join(homeDirectory, ".howto", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      aiProvider: "chatgpt",
      openaiApiUrl: "https://old.example/v1",
      chatgptAccount: "saved-account",
      chatgptModel: "saved-model",
      structuredOutput: false,
    }),
  );
  await validateAndPersistInitializationConfig(
    { provider: "openai", apiKey: "", model: "api-model", openaiBaseUrl: "" },
    { print: false },
    { HOME: homeDirectory },
  );
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    aiProvider: "openai",
    openaiApiKey: "",
    openaiModel: "api-model",
    chatgptAccount: "saved-account",
    chatgptModel: "saved-model",
    structuredOutput: false,
  });
});

test("初始化不覆盖损坏的现有配置", async (t) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-broken-init-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const configPath = join(homeDirectory, ".howto", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  const previous = "{broken-config";
  await writeFile(configPath, previous);
  await assert.rejects(
    validateAndPersistInitializationConfig(
      { provider: "chatgpt", account: "selected-account", model: "selected-model" },
      { print: false },
      { HOME: homeDirectory },
    ),
    ConfigError,
  );
  assert.equal(await readFile(configPath, "utf8"), previous);
});

test("ChatGPT Fast choice persists and reinitializing unknown model clears it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "howto-fast-init-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".howto", "config.json");
  const values = { provider: "chatgpt" as const, account: "fake-account", model: "fake-model" };
  const selected = await validateAndPersistInitializationConfig(
    { ...values, fast: true },
    { print: false },
    { HOME: home },
  );
  assert.equal(selected.chatgpt.fast, true);
  assert.equal(
    (JSON.parse(await readFile(path, "utf8")) as { chatgptFast: boolean }).chatgptFast,
    true,
  );
  const reset = await validateAndPersistInitializationConfig(
    values,
    { print: false },
    { HOME: home },
  );
  assert.equal(reset.chatgpt.fast, true);
  assert.ok(!Object.hasOwn(JSON.parse(await readFile(path, "utf8")) as object, "chatgptFast"));
});
