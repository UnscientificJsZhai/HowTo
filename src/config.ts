import type { GlobalOptions } from "./cli.js";

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
}

export interface ConfigEnvironment {
  HOWTO_AI_PROVIDER?: string;
  HOWTO_GEMINI_API_KEY?: string;
  HOWTO_GEMINI_MODEL?: string;
  HOWTO_OPENAI_API_URL?: string;
  HOWTO_OPENAI_API_KEY?: string;
  HOWTO_OPENAI_MODEL?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_AI_PROVIDER: AiProvider = "openai";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

export function loadConfig(options: GlobalOptions, env: ConfigEnvironment): AppConfig {
  const aiProvider = parseAiProvider(
    pickConfigValue(options.aiProvider, env.HOWTO_AI_PROVIDER) ?? DEFAULT_AI_PROVIDER,
  );

  const config: AppConfig = {
    aiProvider,
    gemini: {
      apiKey: pickConfigValue(options.geminiApiKey, env.HOWTO_GEMINI_API_KEY),
      model: pickConfigValue(options.geminiModel, env.HOWTO_GEMINI_MODEL) ?? DEFAULT_GEMINI_MODEL,
    },
    openai: {
      apiKey: pickConfigValue(options.openaiApiKey, env.HOWTO_OPENAI_API_KEY) ?? "",
      model: pickConfigValue(options.openaiModel, env.HOWTO_OPENAI_MODEL) ?? DEFAULT_OPENAI_MODEL,
      baseUrl: pickConfigValue(options.openaiApiUrl, env.HOWTO_OPENAI_API_URL),
    },
  };

  if (config.aiProvider === "gemini" && isBlank(config.gemini.apiKey)) {
    throw new ConfigError("Gemini provider requires --gemini-api-key or HOWTO_GEMINI_API_KEY");
  }

  return config;
}

function pickConfigValue(
  cliValue: string | undefined,
  envValue: string | undefined,
): string | undefined {
  return cliValue ?? envValue;
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
