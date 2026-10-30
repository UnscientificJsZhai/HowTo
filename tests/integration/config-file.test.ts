import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test, { type TestContext } from "node:test";

import { ConfigError } from "../../src/config.js";
import {
  getConfigFilePath,
  readUserConfigFile,
  writeUserConfigFile,
} from "../../src/config-file.js";

async function tempConfigPath(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "howto-config-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, ".howto", "config.json");
}

async function writeRawConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("readUserConfigFile treats a missing file as empty config", async (t) => {
  assert.deepEqual(await readUserConfigFile(await tempConfigPath(t)), {});
});

test("getConfigFilePath treats missing and blank HOME as absent", () => {
  const expectedPath = join(userInfo().homedir, ".howto", "config.json");

  for (const env of [{}, { HOME: "" }, { HOME: "   " }, { HOME: "\t" }]) {
    const path = getConfigFilePath(env);
    assert.equal(path, expectedPath);
    assert.equal(isAbsolute(dirname(path)), true);
  }
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

test("readUserConfigFile reads known string fields and ignores unknown fields", async (t) => {
  const path = await tempConfigPath(t);
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

test("readUserConfigFile accepts structuredOutput boolean and string values", async (t) => {
  const booleanPath = await tempConfigPath(t);
  await writeRawConfig(booleanPath, '{"aiProvider":"openai","structuredOutput":false}');
  assert.deepEqual(await readUserConfigFile(booleanPath), {
    aiProvider: "openai",
    structuredOutput: false,
  });

  const stringPath = await tempConfigPath(t);
  await writeRawConfig(stringPath, '{"aiProvider":"openai","structuredOutput":"true"}');
  assert.deepEqual(await readUserConfigFile(stringPath), {
    aiProvider: "openai",
    structuredOutput: "true",
  });
});

test("readUserConfigFile rejects non-boolean non-string structuredOutput", async (t) => {
  const path = await tempConfigPath(t);
  await writeRawConfig(path, '{"structuredOutput":1}');
  await assert.rejects(() => readUserConfigFile(path), ConfigError);
});

test("readUserConfigFile uses fixed messages for read, JSON, and root failures", async (t) => {
  const unreadablePath = await tempConfigPath(t);
  await mkdir(unreadablePath, { recursive: true });
  await assert.rejects(
    () => readUserConfigFile(unreadablePath),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "failed to read user config file",
  );

  const invalidJsonPath = await tempConfigPath(t);
  await writeRawConfig(invalidJsonPath, "{");
  await assert.rejects(
    () => readUserConfigFile(invalidJsonPath),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "user config file is not valid JSON",
  );

  const arrayPath = await tempConfigPath(t);
  await writeRawConfig(arrayPath, "[]");
  await assert.rejects(
    () => readUserConfigFile(arrayPath),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message === "user config file must contain a JSON object",
  );
});

test("readUserConfigFile rejects invalid known field types", async (t) => {
  const invalidFieldPath = await tempConfigPath(t);
  await writeRawConfig(invalidFieldPath, '{"aiProvider":42}');

  await assert.rejects(() => readUserConfigFile(invalidFieldPath), ConfigError);
});

test("配置文件支持读写 ChatGPT 选择字段", async (t) => {
  const path = await tempConfigPath(t);
  const config = {
    chatgptAccount: "personal",
    chatgptModel: "available-model",
  };
  await writeUserConfigFile(config, path);
  assert.deepEqual(await readUserConfigFile(path), config);
});

test("writeUserConfigFile creates and fully overwrites config file", async (t) => {
  const path = await tempConfigPath(t);

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

test("writeUserConfigFile cleans temporary data when atomic replacement fails", async (t) => {
  const path = await tempConfigPath(t);
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

test("非 root 配置读权限失败抛出读取错误", async (t) => {
  if (process.getuid?.() === undefined || process.getuid() === 0) {
    t.skip("需要真实非 root POSIX 进程");
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "howto-read-perm-"));
  const directory = join(home, ".howto");
  const path = join(directory, "config.json");
  t.after(async () => {
    await chmod(path, 0o600).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  await writeUserConfigFile({ aiProvider: "gemini", geminiModel: "old" }, path);
  await chmod(path, 0o000);
  await assert.rejects(readUserConfigFile(path), /failed to read user config file/);
});

test("非 root 配置写权限失败保留旧文件且不残留临时数据", async (t) => {
  if (process.getuid?.() === undefined || process.getuid() === 0) {
    t.skip("需要真实非 root POSIX 进程");
    return;
  }
  const home = await mkdtemp(join(tmpdir(), "howto-write-perm-"));
  const directory = join(home, ".howto");
  const path = join(directory, "config.json");
  t.after(async () => {
    await chmod(directory, 0o700).catch(() => {});
    await rm(home, { recursive: true, force: true });
  });
  await writeUserConfigFile({ aiProvider: "gemini", geminiModel: "old" }, path);
  const original = await readFile(path, "utf8");
  await chmod(directory, 0o500);
  await assert.rejects(
    writeUserConfigFile({ aiProvider: "openai" }, path),
    /failed to save user config file/,
  );
  await chmod(directory, 0o700);
  assert.equal(await readFile(path, "utf8"), original);
  assert.deepEqual(await readdir(directory), ["config.json"]);
});

test("并发初始化只能留下完整的单份配置，权限为 0600", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "howto-concurrent-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, ".howto", "config.json");
  const configs = Array.from({ length: 12 }, (_, i) => ({
    aiProvider: "gemini",
    geminiApiKey: `fake-key-${i}`,
    geminiModel: `model-${i}`,
  }));
  await Promise.all(configs.map((config) => writeUserConfigFile(config, path)));
  const actual = await readUserConfigFile(path);
  assert.ok(configs.some((config) => JSON.stringify(config) === JSON.stringify(actual)));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
});

test("ChatGPT Fast and timing settings accept booleans/strings and reject objects", async (t) => {
  const path = await tempConfigPath(t);
  for (const value of [true, false, "true", "false"]) {
    await writeUserConfigFile({ chatgptFast: value, chatgptTimings: value }, path);
    assert.deepEqual(await readUserConfigFile(path), { chatgptFast: value, chatgptTimings: value });
  }
  await writeRawConfig(path, '{"chatgptFast":{}}');
  await assert.rejects(readUserConfigFile(path), ConfigError);
});
