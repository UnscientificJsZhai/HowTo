import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  type Content,
  type GenerateContentParameters,
  type GoogleGenAIOptions,
} from "@google/genai";

import type { AppConfig } from "../config.js";
import type { UsageGenerationSession, UsageToolCall } from "../usage/types.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";
import { COMMAND_GENERATION_SCHEMA, USAGE_COMMAND_GENERATION_SCHEMA } from "./command-schema.js";
import { AiProviderError } from "./errors.js";
import {
  runUsageProviderRequest,
  USAGE_TOOL_DESCRIPTION,
  USAGE_TOOL_NAME,
  USAGE_TOOL_PARAMETERS,
  UsageReplyTracker,
} from "./usage-session.js";

export interface GeminiDependencies {
  client?: GoogleGenAI;
  timeoutMilliseconds?: number;
}

export class GeminiCommandProvider implements CommandProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMilliseconds: number | undefined;

  constructor(config: AppConfig["gemini"], dependencies: GeminiDependencies = {}) {
    this.model = config.model;
    this.apiKey = config.apiKey;
    this.timeoutMilliseconds = dependencies.timeoutMilliseconds;
    this.client = dependencies.client ?? new GoogleGenAI(buildGeminiClientOptions(config));
  }

  createUsageSession(request: GenerateCommandsRequest): UsageGenerationSession {
    const contents: Content[] = [{ role: "user", parts: [{ text: request.userPrompt }] }];
    const tracker = new UsageReplyTracker("gemini", this.model);
    const associations = new Map<string, { name: string; nativeId?: string }>();
    let turn = 0;
    return {
      getKnownCredentials: () => (this.apiKey === undefined ? [] : [this.apiKey]),
      next: (replies, options, signal) =>
        runUsageProviderRequest(
          "gemini",
          this.model,
          signal,
          this.timeoutMilliseconds,
          options.toolsEnabled,
          async (requestSignal) => {
            const fresh = tracker.accept(replies);
            if (fresh.length > 0) {
              contents.push({
                role: "user",
                parts: fresh.map((reply) => {
                  const association = associations.get(reply.callId);
                  if (association === undefined) throw new AiProviderError("gemini", this.model);
                  return {
                    functionResponse: {
                      name: association.name,
                      ...(association.nativeId === undefined ? {} : { id: association.nativeId }),
                      response: { output: reply.result },
                    },
                  };
                }),
              });
            }
            const parameters: GenerateContentParameters = {
              model: this.model,
              contents: [...contents],
              config: {
                systemInstruction: request.systemPrompt,
                responseMimeType: "application/json",
                abortSignal: requestSignal,
                httpOptions: { retryOptions: { attempts: 1 } },
                automaticFunctionCalling: { disable: true },
                ...(request.structuredOutput
                  ? { responseJsonSchema: USAGE_COMMAND_GENERATION_SCHEMA }
                  : {}),
                ...(options.toolsEnabled
                  ? {
                      tools: [
                        {
                          functionDeclarations: [
                            {
                              name: USAGE_TOOL_NAME,
                              description: USAGE_TOOL_DESCRIPTION,
                              parametersJsonSchema: USAGE_TOOL_PARAMETERS,
                            },
                          ],
                        },
                      ],
                      toolConfig: {
                        functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO },
                      },
                    }
                  : {}),
              },
            };
            const response = await this.client.models.generateContent(parameters);
            requestSignal.throwIfAborted();
            const content = response.candidates?.[0]?.content;
            const calls = readGeminiUsageCalls(content, this.model, turn++);
            if (calls.length > 0) {
              tracker.register(calls.map(({ call }) => call));
              for (const { call, nativeId } of calls) {
                associations.set(call.id, { name: call.name, nativeId });
              }
              // 不用 SDK functionCalls getter 重建消息，原样保留所有 model parts 与签名。
              contents.push({ ...content, role: "model" });
              return { kind: "tool_calls", calls: calls.map(({ call }) => call) };
            }
            const rawText = extractGeminiResponseText(response);
            if (rawText === undefined || rawText.trim() === "") {
              throw new AiProviderError("gemini", this.model);
            }
            return { kind: "final", rawText };
          },
        ),
    };
  }

  async generateCommands(
    request: GenerateCommandsRequest,
    signal?: AbortSignal,
  ): Promise<GenerateCommandsResult> {
    let rawText: string | undefined;
    try {
      const response = await this.client.models.generateContent(
        buildGeminiGenerateContentRequest(this.model, request, signal),
      );
      rawText = extractGeminiResponseText(response);
    } catch {
      throw new AiProviderError("gemini", this.model);
    }

    if (rawText === undefined || rawText.trim() === "") {
      throw new AiProviderError("gemini", this.model);
    }

    return { rawText };
  }
}

function readGeminiUsageCalls(
  content: unknown,
  model: string,
  turn: number,
): { call: UsageToolCall; nativeId?: string }[] {
  const parts = asRecord(content)?.parts;
  if (!Array.isArray(parts) || parts.length === 0) throw new AiProviderError("gemini", model);
  const calls: { call: UsageToolCall; nativeId?: string }[] = [];
  for (const [index, value] of parts.entries()) {
    const part = asRecord(value);
    if (
      part === undefined ||
      (Object.hasOwn(part, "thought") && typeof part.thought !== "boolean") ||
      (Object.hasOwn(part, "text") && typeof part.text !== "string")
    ) {
      throw new AiProviderError("gemini", model);
    }
    if (!Object.hasOwn(part, "functionCall")) continue;
    const call = asRecord(part.functionCall);
    if (
      call === undefined ||
      typeof call.name !== "string" ||
      call.name === "" ||
      (call.id !== undefined && (typeof call.id !== "string" || call.id === ""))
    ) {
      throw new AiProviderError("gemini", model);
    }
    const nativeId = call.id;
    calls.push({
      call: { id: nativeId ?? `gemini-${turn}-${index}`, name: call.name, arguments: call.args },
      nativeId,
    });
  }
  return calls;
}

export function extractGeminiResponseText(response: unknown): string | undefined {
  // SDK 的 text getter 会记录未知字段；这里只读取首候选的已知字段。
  const candidates = asRecord(response)?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const parts = asRecord(asRecord(candidates[0])?.content)?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return undefined;

  let text = "";
  let hasText = false;
  for (const value of parts) {
    const part = asRecord(value);
    if (part === undefined) return undefined;
    const thought = part.thought;
    if (Object.hasOwn(part, "thought") && typeof thought !== "boolean") return undefined;
    if (thought === true) continue;
    if (!Object.hasOwn(part, "text")) continue;
    const partText = part.text;
    if (typeof partText !== "string") return undefined;
    hasText = true;
    text += partText;
  }
  return hasText ? text : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function buildGeminiClientOptions(config: AppConfig["gemini"]): GoogleGenAIOptions {
  return {
    apiKey: config.apiKey,
    enterprise: false,
    vertexai: false,
    apiVersion: "v1beta",
    httpOptions: { baseUrl: "https://generativelanguage.googleapis.com/" },
  };
}

export function buildGeminiGenerateContentRequest(
  model: string,
  request: GenerateCommandsRequest,
  signal?: AbortSignal,
): GenerateContentParameters {
  return {
    model,
    contents: request.userPrompt,
    config: {
      systemInstruction: request.systemPrompt,
      responseMimeType: "application/json",
      ...(signal === undefined ? {} : { abortSignal: signal }),
      ...(request.structuredOutput ? { responseJsonSchema: COMMAND_GENERATION_SCHEMA } : {}),
    },
  };
}
