import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";

import type { AppConfig } from "../config.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";
import type { UsageGenerationSession, UsageToolCall } from "../usage/types.js";
import { COMMAND_GENERATION_SCHEMA, USAGE_COMMAND_GENERATION_SCHEMA } from "./command-schema.js";
import { AiProviderError } from "./errors.js";
import {
  isRecord,
  parseUsageToolArguments,
  runUsageProviderRequest,
  USAGE_TOOL_DESCRIPTION,
  USAGE_TOOL_NAME,
  USAGE_TOOL_PARAMETERS,
  UsageReplyTracker,
} from "./usage-session.js";

export interface OpenAiDependencies {
  client?: OpenAI;
  timeoutMilliseconds?: number;
}

export class OpenAiCommandProvider implements CommandProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMilliseconds: number | undefined;

  constructor(config: AppConfig["openai"], dependencies: OpenAiDependencies = {}) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMilliseconds = dependencies.timeoutMilliseconds;
    if (dependencies.client !== undefined) {
      this.client = dependencies.client;
      return;
    }
    try {
      this.client = new OpenAI(buildOpenAiClientOptions(config));
    } catch {
      // SDK 初始化异常可能含自定义请求头原值，与请求失败使用同一固定错误边界。
      throw new AiProviderError("openai", this.model);
    }
  }

  createUsageSession(request: GenerateCommandsRequest): UsageGenerationSession {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt },
    ];
    const tracker = new UsageReplyTracker("openai", this.model);
    return {
      getKnownCredentials: () => [this.apiKey],
      next: (replies, options, signal) =>
        runUsageProviderRequest(
          "openai",
          this.model,
          signal,
          this.timeoutMilliseconds,
          options.toolsEnabled,
          async (requestSignal) => {
            for (const reply of tracker.accept(replies)) {
              messages.push({
                role: "tool",
                tool_call_id: reply.callId,
                content: JSON.stringify(reply.result),
              });
            }
            const parameters = buildOpenAiChatCompletionRequest(this.model, request);
            parameters.messages = [...messages];
            if (request.structuredOutput) {
              parameters.response_format = {
                type: "json_schema",
                json_schema: {
                  name: "command_usage_generation",
                  schema: USAGE_COMMAND_GENERATION_SCHEMA,
                  strict: true,
                },
              };
            }
            if (options.toolsEnabled) {
              parameters.tools = [
                {
                  type: "function",
                  function: {
                    name: USAGE_TOOL_NAME,
                    description: USAGE_TOOL_DESCRIPTION,
                    parameters: USAGE_TOOL_PARAMETERS,
                    strict: true,
                  },
                },
              ];
              parameters.tool_choice = "auto";
              parameters.parallel_tool_calls = false;
            }
            const response = await this.client.chat.completions.create(parameters, {
              signal: requestSignal,
              maxRetries: 0,
            });
            requestSignal.throwIfAborted();
            const message = response.choices[0]?.message;
            if (!isRecord(message) || message.refusal)
              throw new AiProviderError("openai", this.model);
            const calls = readOpenAiUsageCalls(message, this.model);
            if (calls.length > 0) {
              tracker.register(calls);
              messages.push({
                role: "assistant",
                content: typeof message.content === "string" ? message.content : null,
                tool_calls: message.tool_calls,
                // 兼容推理服务要求后续工具回合原样回传此字段，包括空字符串。
                ...(typeof message.reasoning_content === "string"
                  ? { reasoning_content: message.reasoning_content }
                  : {}),
              });
              return { kind: "tool_calls", calls };
            }
            if (typeof message.content !== "string" || message.content.trim() === "") {
              throw new AiProviderError("openai", this.model);
            }
            return { kind: "final", rawText: message.content };
          },
        ),
    };
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

function readOpenAiUsageCalls(message: Record<string, unknown>, model: string): UsageToolCall[] {
  if (message.tool_calls == null) return [];
  if (!Array.isArray(message.tool_calls)) throw new AiProviderError("openai", model);
  return message.tool_calls.map((call: unknown) => {
    if (
      !isRecord(call) ||
      call.type !== "function" ||
      typeof call.id !== "string" ||
      !isRecord(call.function) ||
      typeof call.function.name !== "string" ||
      call.function.name === "" ||
      typeof call.function.arguments !== "string"
    ) {
      throw new AiProviderError("openai", model);
    }
    return {
      id: call.id,
      name: call.function.name,
      arguments: parseUsageToolArguments(call.function.arguments),
    };
  });
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
