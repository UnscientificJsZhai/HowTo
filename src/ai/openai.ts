import OpenAI, { type ClientOptions } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";

import type { AppConfig } from "../config.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";
import { COMMAND_GENERATION_SCHEMA } from "./command-schema.js";
import { AiProviderError } from "./errors.js";

export class OpenAiCommandProvider implements CommandProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: AppConfig["openai"]) {
    this.model = config.model;
    this.client = new OpenAI(buildOpenAiClientOptions(config));
  }

  async generateCommands(request: GenerateCommandsRequest): Promise<GenerateCommandsResult> {
    try {
      const response = await this.client.chat.completions.create(
        buildOpenAiChatCompletionRequest(this.model, request),
      );

      const rawText = response.choices[0]?.message?.content;
      if (rawText === undefined || rawText === null || rawText.trim() === "") {
        throw new Error("provider returned an empty response");
      }

      return { rawText };
    } catch (error: unknown) {
      throw new AiProviderError("openai", this.model, error);
    }
  }
}

export function buildOpenAiClientOptions(config: AppConfig["openai"]): ClientOptions {
  if (config.apiKey.trim() !== "") {
    return {
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    };
  }

  return {
    apiKey: "howto-empty-api-key",
    baseURL: config.baseUrl,
    defaultHeaders: {
      Authorization: null,
    },
  };
}

export function buildOpenAiChatCompletionRequest(
  model: string,
  request: GenerateCommandsRequest,
): ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ],
    response_format: request.structuredOutput
      ? {
          type: "json_schema",
          json_schema: {
            name: "command_generation",
            description: "Shell command candidates generated for howto.",
            schema: COMMAND_GENERATION_SCHEMA,
            strict: true,
          },
        }
      : { type: "json_object" },
  };
}
