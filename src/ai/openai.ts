import OpenAI from "openai";

import type { AppConfig } from "../config";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types";
import { AiProviderError } from "./errors";

export class OpenAiCommandProvider implements CommandProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config: AppConfig["openai"]) {
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
  }

  async generateCommands(request: GenerateCommandsRequest): Promise<GenerateCommandsResult> {
    try {
      const response = await this.client.responses.create({
        model: this.model,
        input: request.prompt,
      });

      const rawText = response.output_text;
      if (rawText === undefined || rawText.trim() === "") {
        throw new Error("provider returned an empty response");
      }

      return { rawText };
    } catch (error: unknown) {
      throw new AiProviderError("openai", this.model, error);
    }
  }
}
