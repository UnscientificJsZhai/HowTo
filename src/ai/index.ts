import type { AppConfig } from "../config.js";
import { GeminiCommandProvider } from "./gemini.js";
import { OpenAiCommandProvider } from "./openai.js";
import type { CommandProvider } from "./types.js";

export function createCommandProvider(config: AppConfig): CommandProvider {
  switch (config.aiProvider) {
    case "openai":
      return new OpenAiCommandProvider(config.openai);
    case "gemini":
      return new GeminiCommandProvider(config.gemini);
    default: {
      const exhaustive: never = config.aiProvider;
      return exhaustive;
    }
  }
}

export { AiProviderError } from "./errors.js";
