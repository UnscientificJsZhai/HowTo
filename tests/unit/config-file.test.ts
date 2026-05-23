import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { ConfigError } from "../../src/config.js";
import { readUserConfigFile, writeUserConfigFile } from "../../src/config-file.js";
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

test("readUserConfigFile rejects invalid JSON, non-object roots, and non-string known fields", async () => {
  const invalidJsonPath = await tempConfigPath();
  await writeRawConfig(invalidJsonPath, "{");
  await assert.rejects(() => readUserConfigFile(invalidJsonPath), ConfigError);

  const arrayPath = await tempConfigPath();
  await writeRawConfig(arrayPath, "[]");
  await assert.rejects(() => readUserConfigFile(arrayPath), ConfigError);

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
