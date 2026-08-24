import { AiProviderError } from "./ai/index.js";
import { CliParseError, USAGE } from "./cli.js";
import { ConfigError } from "./config.js";
import { AiResponseValidationError } from "./validation/ai-response.js";
import { InteractionCancelledError, InteractiveTtyError } from "./ui/tty.js";
import { PlaceholderResolutionError } from "./ui/placeholder-logic.js";
import { sanitizeUserVisibleErrorMessage } from "./user-visible-error.js";

export { sanitizeUserVisibleErrorMessage };

export function getUserVisibleErrorMessage(error: Error): string {
  if (error instanceof AiProviderError) {
    return `AI provider request failed (provider: ${error.provider}, model: ${sanitizeUserVisibleErrorMessage(error.model)})`;
  }

  return sanitizeUserVisibleErrorMessage(error.message);
}

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
    return new AppError(sanitizeUserVisibleErrorMessage(error.message), error.exitCode);
  }

  if (error instanceof CliParseError) {
    return new AppError(`Error: ${sanitizeUserVisibleErrorMessage(error.message)}\n${USAGE}`, 2);
  }

  if (error instanceof ConfigError) {
    return new AppError(
      `Configuration error: ${sanitizeUserVisibleErrorMessage(error.message)}`,
      2,
    );
  }

  if (error instanceof AiProviderError) {
    return new AppError(getUserVisibleErrorMessage(error), 1);
  }

  if (error instanceof AiResponseValidationError) {
    return new AppError(
      `AI response format error: ${sanitizeUserVisibleErrorMessage(error.message)}`,
      2,
    );
  }

  if (error instanceof InteractiveTtyError) {
    return new AppError(`Error: ${sanitizeUserVisibleErrorMessage(error.message)}`, 2);
  }

  if (error instanceof PlaceholderResolutionError) {
    return new AppError(`Error: ${sanitizeUserVisibleErrorMessage(error.message)}`, 2);
  }

  if (error instanceof InteractionCancelledError) {
    return new AppError("", 130);
  }

  return new AppError(`Error: ${sanitizeUserVisibleErrorMessage(getErrorMessage(error))}`, 1);
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
