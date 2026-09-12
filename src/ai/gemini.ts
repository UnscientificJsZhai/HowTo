import {
  GoogleGenAI,
  type GenerateContentParameters,
  type GoogleGenAIOptions,
} from "@google/genai";

import type { AppConfig } from "../config.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";
import { COMMAND_GENERATION_SCHEMA } from "./command-schema.js";
import { AiProviderError } from "./errors.js";

export class GeminiCommandProvider implements CommandProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(config: AppConfig["gemini"]) {
    this.model = config.model;
    this.client = new GoogleGenAI(buildGeminiClientOptions(config));
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
