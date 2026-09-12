import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  const expectedPath = join(userInfo().homedir, ".howto", "config.json");

  for (const env of [{}, { HOME: "" }, { HOME: "   " }, { HOME: "\t" }]) {
    const path = getConfigFilePath(env);
    assert.equal(path, expectedPath);
    assert.equal(isAbsolute(dirname(path)), true);
  }
});

for (const [label, home] of [
  ["absent", undefined],
  ["empty", ""],
  ["spaces", "   "],
  ["tab", "\t"],
] as const) {
  test(`真实子进程 HOME ${label} 使用系统目录且不创建配置`, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "howto-home-child-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/config-home-child.js", import.meta.url))],
      {
        cwd,
        env: home === undefined ? {} : { HOME: home },
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout, '{"matchesSystemHome":true,"absolute":true}\n');
    assert.deepEqual(await readdir(cwd), []);
  });
}

test("getConfigFilePath accepts an absolute HOME and rejects a relative HOME", async () => {
  const absoluteHome = await mkdtemp(join(tmpdir(), "howto-home-test-"));

  assert.equal(
    getConfigFilePath({ HOME: absoluteHome }),
    join(absoluteHome, ".howto", "config.json"),
  );
  assert.throws(() => getConfigFilePath({ HOME: "relative-home" }), ConfigError);
});

test("HOME 缺失或为空白时只查询一次系统目录", () => {
  const systemHome = join(tmpdir(), "howto-system-home");
  for (const env of [{}, { HOME: "" }, { HOME: "   " }, { HOME: "\t" }]) {
    let queries = 0;
    assert.equal(
      getConfigFilePath(env, () => {
        queries += 1;
        return systemHome;
      }),
      join(systemHome, ".howto", "config.json"),
    );
    assert.equal(queries, 1);
  }
});

test("显式非空 HOME 保留原值且不调用系统查询", () => {
  const absoluteHome = `${join(tmpdir(), "howto-preserved-home")} `;
  const unexpectedLookup = () => {
    throw new Error("HOWTO_FAKE_UNEXPECTED_LOOKUP_SECRET");
  };
  assert.equal(
    getConfigFilePath({ HOME: absoluteHome }, unexpectedLookup),
    join(absoluteHome, ".howto", "config.json"),
  );
  assert.throws(
    () => getConfigFilePath({ HOME: " relative-home " }, unexpectedLookup),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "config directory must be an absolute path",
  );
});

test("系统目录查询异常只返回固定配置错误", () => {
  assert.throws(
    () =>
      getConfigFilePath({ HOME: " " }, () => {
        throw new Error("\u001b[2JHOWTO_FAKE_HOME_LOOKUP_SECRET /private/fake-home");
      }),
    isSystemHomeError,
  );
});

for (const [label, value] of [
  ["undefined", undefined],
  ["null", null],
  ["number", 7],
  ["object", {}],
  ["empty", ""],
  ["spaces", "   "],
  ["tab", "\t"],
  ["relative", "relative-home"],
] as const) {
  test(`系统目录查询返回 ${label} 时固定失败`, () => {
    assert.throws(() => getConfigFilePath({}, () => value as string), isSystemHomeError);
  });
}

function isSystemHomeError(error: unknown): boolean {
  return error instanceof ConfigError && error.message === "failed to resolve user home directory";
}

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
