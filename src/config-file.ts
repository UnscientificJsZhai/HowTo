import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { ConfigError } from "./config.js";

export interface FileConfig {
  aiProvider?: string;
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  structuredOutput?: string | boolean;
}

const CONFIG_FILE_FIELDS = new Set<keyof FileConfig>([
  "aiProvider",
  "geminiApiKey",
  "geminiModel",
  "openaiApiUrl",
  "openaiApiKey",
  "openaiModel",
  "structuredOutput",
]);

export function getConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = env.HOME;
  const homeDirectory =
    configuredHome === undefined || configuredHome.trim() === "" ? homedir() : configuredHome;
  const configDirectory = join(homeDirectory, ".howto");

  assertAbsoluteConfigDirectory(configDirectory);
  return join(configDirectory, "config.json");
}

export async function readUserConfigFile(path = getConfigFilePath()): Promise<FileConfig> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isFileNotFoundError(error)) {
      return {};
    }

    throw new ConfigError("failed to read user config file");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new ConfigError("user config file is not valid JSON");
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError("user config file must contain a JSON object");
  }

  const config: FileConfig = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!CONFIG_FILE_FIELDS.has(key as keyof FileConfig)) {
      continue;
    }

    if (key === "structuredOutput") {
      if (typeof value !== "string" && typeof value !== "boolean") {
        throw new ConfigError(`config file field ${key} must be a boolean or string`);
      }

      config.structuredOutput = value;
      continue;
    }

    if (typeof value !== "string") {
      throw new ConfigError(`config file field ${key} must be a string`);
    }

    config[key as keyof FileConfig] = value;
  }

  return config;
}

export async function writeUserConfigFile(
  config: FileConfig,
  path = getConfigFilePath(),
): Promise<void> {
  const configDirectory = dirname(path);
  assertAbsoluteConfigDirectory(configDirectory);

  const serializedConfig = `${JSON.stringify(config, null, 2)}\n`;

  let temporaryDirectory: string;
  try {
    await mkdir(configDirectory, { recursive: true });
    temporaryDirectory = await mkdtemp(join(configDirectory, `.${basename(path)}-`));
  } catch {
    throw new ConfigError("failed to save user config file");
  }

  const temporaryPath = join(temporaryDirectory, basename(path));

  try {
    await writeFile(temporaryPath, serializedConfig, "utf8");
    await rename(temporaryPath, path);
  } catch {
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch {
      throw new ConfigError("failed to save user config file and remove temporary config data");
    }

    throw new ConfigError("failed to save user config file");
  }

  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch {
    // 配置已经通过原子重命名提交；空临时目录清理失败不能把成功写入报告为失败。
  }
}

function assertAbsoluteConfigDirectory(path: string): void {
  if (!isAbsolute(path)) {
    throw new ConfigError("config directory must be an absolute path");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
