import { GoogleGenAI } from "@google/genai";

import type { AppConfig } from "../config.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";
import { AiProviderError } from "./errors.js";

export class GeminiCommandProvider implements CommandProvider {
  private readonly client: GoogleGenAI;
  private readonly model: string;

  constructor(config: AppConfig["gemini"]) {
    this.model = config.model;
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async generateCommands(request: GenerateCommandsRequest): Promise<GenerateCommandsResult> {
    try {
      const response = await this.client.models.generateContent({
        model: this.model,
        contents: request.userPrompt,
        config: {
          systemInstruction: request.systemPrompt,
          responseMimeType: "application/json",
        },
      });

      const rawText = response.text;
      if (rawText === undefined || rawText.trim() === "") {
        throw new Error("provider returned an empty response");
      }

      return { rawText };
    } catch (error: unknown) {
      throw new AiProviderError("gemini", this.model, error);
    }
  }
}
