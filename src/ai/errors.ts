import type { AiProvider } from "../config.js";
import { sanitizeUserVisibleErrorMessage } from "../user-visible-error.js";

export class AiProviderError extends Error {
  readonly provider: AiProvider;
  readonly model: string;

  constructor(provider: AiProvider, model: string) {
    super(formatProviderError(provider, model));
    this.name = "AiProviderError";
    this.provider = provider;
    this.model = model;
  }
}

function formatProviderError(provider: AiProvider, model: string): string {
  return `AI provider request failed (provider: ${provider}, model: ${sanitizeUserVisibleErrorMessage(model)})`;
}
