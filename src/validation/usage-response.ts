import type { CommandGenerationContract } from "../ai/types.js";
import { AppError } from "../errors.js";
import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";
import { AiResponseValidationError, parseAndValidateAiResponse } from "./ai-response.js";

export class UsageGenerationFailureError extends AppError {
  constructor(reason: string) {
    super(reason, 2);
    this.name = "UsageGenerationFailureError";
  }
}

/** 仅交互式 use 会话接受明确失败；成功候选继续通过既有全部强校验。 */
export function parseAndValidateUsageResponse(rawText: string): CommandGenerationContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new AiResponseValidationError("AI response is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AiResponseValidationError("AI response root must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (
    Object.keys(root).some((key) => key !== "commands" && key !== "failureReason") ||
    !Array.isArray(root.commands) ||
    typeof root.failureReason !== "string" ||
    hasUnsafeTerminalControlCharacters(root.failureReason)
  ) {
    throw new AiResponseValidationError("usage response must contain commands and failureReason");
  }
  if (root.commands.length === 0) {
    if (root.failureReason.trim() === "") {
      throw new AiResponseValidationError("empty commands require a non-empty failureReason");
    }
    throw new UsageGenerationFailureError(root.failureReason);
  }
  if (root.failureReason !== "") {
    throw new AiResponseValidationError("successful commands require an empty failureReason");
  }
  return parseAndValidateAiResponse(rawText);
}
