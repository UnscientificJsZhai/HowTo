import { AiProviderError } from "./ai/index.js";
import { CliParseError, USAGE } from "./cli.js";
import { ConfigError } from "./config.js";
import { AiResponseValidationError } from "./validation/ai-response.js";
import { InteractionCancelledError, InteractiveTtyError } from "./ui/tty.js";
import { PlaceholderResolutionError } from "./ui/placeholder-logic.js";

export class AppError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "AppError";
    this.exitCode = exitCode;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof CliParseError) {
    return new AppError(`Error: ${error.message}\n${USAGE}`, 2);
  }

  if (error instanceof ConfigError) {
    return new AppError(`Configuration error: ${error.message}`, 2);
  }

  if (error instanceof AiProviderError) {
    return new AppError(error.message, 1);
  }

  if (error instanceof AiResponseValidationError) {
    return new AppError(`AI response format error: ${error.message}`, 2);
  }

  if (error instanceof InteractiveTtyError) {
    return new AppError(`Error: ${error.message}`, 2);
  }

  if (error instanceof PlaceholderResolutionError) {
    return new AppError(`Error: ${error.message}`, 2);
  }

  if (error instanceof InteractionCancelledError) {
    return new AppError("", 130);
  }

  return new AppError(`Error: ${sanitizeErrorMessage(getErrorMessage(error))}`, 1);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  if (typeof error === "string" && error.trim() !== "") {
    return error;
  }

  return "unknown error";
}

function sanitizeErrorMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  const redacted = singleLine
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(api[-_ ]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(authorization["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]");

  return redacted.length > 220 ? `${redacted.slice(0, 217)}...` : redacted;
}
