import type { GlobalOptions } from "./cli.js";
import type { FileConfig } from "./config-file.js";

export type AiProvider = "openai" | "gemini";

export interface AppConfig {
  aiProvider: AiProvider;
  gemini: {
    apiKey?: string;
    model: string;
  };
  openai: {
    apiKey: string;
    model: string;
    baseUrl?: string;
  };
  structuredOutput: boolean;
}

export interface ConfigEnvironment {
  HOWTO_AI_PROVIDER?: string;
  HOWTO_GEMINI_API_KEY?: string;
  HOWTO_GEMINI_MODEL?: string;
  HOWTO_OPENAI_API_URL?: string;
  HOWTO_OPENAI_API_KEY?: string;
  HOWTO_OPENAI_MODEL?: string;
  HOWTO_STRUCTURED_OUTPUT?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL };

export function hasExplicitAiProvider(
  options: GlobalOptions,
  env: ConfigEnvironment,
  fileConfig: FileConfig = {},
): boolean {
  return (
    pickConfigValue(options.aiProvider, env.HOWTO_AI_PROVIDER, fileConfig.aiProvider) !== undefined
  );
}

export function loadConfig(
  options: GlobalOptions,
  env: ConfigEnvironment,
  fileConfig: FileConfig = {},
): AppConfig {
  const aiProviderValue = pickConfigValue(
    options.aiProvider,
    env.HOWTO_AI_PROVIDER,
    fileConfig.aiProvider,
  );

  if (aiProviderValue === undefined) {
    throw new ConfigError(
      "AI provider is not configured. Set --ai-provider or HOWTO_AI_PROVIDER, or run howto in an interactive terminal to initialize it.",
    );
  }

  const aiProvider = parseAiProvider(aiProviderValue);

  const config: AppConfig = {
    aiProvider,
    gemini: {
      apiKey: pickConfigValue(
        options.geminiApiKey,
        env.HOWTO_GEMINI_API_KEY,
        fileConfig.geminiApiKey,
      ),
      model:
        pickConfigValue(options.geminiModel, env.HOWTO_GEMINI_MODEL, fileConfig.geminiModel) ??
        DEFAULT_GEMINI_MODEL,
    },
    openai: {
      apiKey:
        pickConfigValue(options.openaiApiKey, env.HOWTO_OPENAI_API_KEY, fileConfig.openaiApiKey) ??
        "",
      model:
        pickConfigValue(options.openaiModel, env.HOWTO_OPENAI_MODEL, fileConfig.openaiModel) ??
        DEFAULT_OPENAI_MODEL,
      baseUrl: pickConfigValue(
        options.openaiApiUrl,
        env.HOWTO_OPENAI_API_URL,
        fileConfig.openaiApiUrl,
      ),
    },
    structuredOutput: parseStructuredOutput(
      pickConfigValue(
        options.structuredOutput,
        env.HOWTO_STRUCTURED_OUTPUT,
        fileConfig.structuredOutput,
      ),
    ),
  };

  if (config.aiProvider === "gemini" && isBlank(config.gemini.apiKey)) {
    throw new ConfigError("Gemini provider requires --gemini-api-key or HOWTO_GEMINI_API_KEY");
  }

  return config;
}

function pickConfigValue(
  cliValue: string | undefined,
  envValue: string | undefined,
  fileValue: string | undefined,
): string | undefined;
function pickConfigValue(
  cliValue: string | undefined,
  envValue: string | undefined,
  fileValue: string | boolean | undefined,
): string | boolean | undefined;
function pickConfigValue(
  cliValue: string | undefined,
  envValue: string | undefined,
  fileValue: string | boolean | undefined,
): string | boolean | undefined {
  return cliValue ?? envValue ?? fileValue;
}

function parseAiProvider(value: string): AiProvider {
  if (value === "openai" || value === "gemini") {
    return value;
  }

  throw new ConfigError("invalid AI provider; expected openai or gemini");
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

function parseStructuredOutput(value: string | boolean | undefined): boolean {
  if (value === undefined) {
    return true;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new ConfigError("invalid structuredOutput value; expected true or false");
}
