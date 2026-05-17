import type { AiProvider } from "../config";

export class AiProviderError extends Error {
  readonly provider: AiProvider;
  readonly model: string;

  constructor(provider: AiProvider, model: string, cause: unknown) {
    super(formatProviderError(provider, model, cause));
    this.name = "AiProviderError";
    this.provider = provider;
    this.model = model;
  }
}

function formatProviderError(provider: AiProvider, model: string, cause: unknown): string {
  const summary = sanitizeErrorSummary(cause);
  return `AI provider request failed (provider: ${provider}, model: ${model}): ${summary}`;
}

function sanitizeErrorSummary(cause: unknown): string {
  const rawMessage = getErrorMessage(cause);
  const singleLine = rawMessage.replace(/\s+/g, " ").trim();
  const redacted = singleLine
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[-_ ]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(authorization["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");

  return redacted.length > 220 ? `${redacted.slice(0, 217)}...` : redacted;
}

function getErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") {
    return cause.message;
  }

  if (typeof cause === "string" && cause.trim() !== "") {
    return cause;
  }

  return "unknown error";
}
