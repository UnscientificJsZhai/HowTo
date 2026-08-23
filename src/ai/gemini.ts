import { GoogleGenAI, type GenerateContentParameters } from "@google/genai";

import type { AppConfig } from "../config.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";
import { COMMAND_GENERATION_SCHEMA } from "./command-schema.js";
import { AiProviderError } from "./errors.js";

export class GeminiCommandProvider implements CommandProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(config: AppConfig["gemini"]) {
    this.model = config.model;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
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
      rawText = response.text;
    } catch {
      throw new AiProviderError("gemini", this.model);
    }

    if (rawText === undefined || rawText.trim() === "") {
      throw new AiProviderError("gemini", this.model);
    }

    return { rawText };
  }
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
