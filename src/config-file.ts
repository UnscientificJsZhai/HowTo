import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
  return join(env.HOME ?? homedir(), ".howto", "config.json");
}

export async function readUserConfigFile(path = getConfigFilePath()): Promise<FileConfig> {
  if (!existsSync(path)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new ConfigError(`failed to read config file ${path}: ${getParseErrorMessage(error)}`);
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError(`config file ${path} must contain a JSON object`);
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
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getParseErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "invalid JSON";
}
