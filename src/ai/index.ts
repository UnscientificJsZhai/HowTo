import type { AppConfig } from "../config";
import { GeminiCommandProvider } from "./gemini";
import { OpenAiCommandProvider } from "./openai";
import type { CommandProvider } from "./types";

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

export { AiProviderError } from "./errors";
