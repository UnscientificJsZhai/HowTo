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
    try {
      this.client = new OpenAI(buildOpenAiClientOptions(config));
    } catch {
      // SDK 初始化异常可能含自定义请求头原值，与请求失败使用同一固定错误边界。
      throw new AiProviderError("openai", this.model);
    }
  }

  async generateCommands(
    request: GenerateCommandsRequest,
    signal?: AbortSignal,
  ): Promise<GenerateCommandsResult> {
    let rawText: unknown;
    try {
      const parameters = buildOpenAiChatCompletionRequest(this.model, request);
      // SDK 重试等待不响应取消；交互请求关闭自动重试，避免取消后残留计时器。
      const response =
        signal === undefined
          ? await this.client.chat.completions.create(parameters)
          : await this.client.chat.completions.create(parameters, { signal, maxRetries: 0 });
      rawText = response.choices[0]?.message?.content;
    } catch {
      throw new AiProviderError("openai", this.model);
    }

    if (typeof rawText !== "string" || rawText.trim() === "") {
      throw new AiProviderError("openai", this.model);
    }

    return { rawText };
  }
}

export function buildOpenAiClientOptions(config: AppConfig["openai"]): ClientOptions {
  const baseURL = config.baseUrl || "https://api.openai.com/v1";

  if (config.apiKey.trim() !== "") {
    return {
      apiKey: config.apiKey,
      baseURL,
      logLevel: "off",
      // 最终认证头必须覆盖 SDK 隐式读取的 OPENAI_CUSTOM_HEADERS。
      defaultHeaders: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    };
  }

  return {
    apiKey: "howto-empty-api-key",
    baseURL,
    logLevel: "off",
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
