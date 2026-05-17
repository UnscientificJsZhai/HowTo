import type {
  CommandCandidateContract,
  CommandGenerationContract,
  CommandPlaceholderContract,
} from "../ai/types";

export class AiResponseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiResponseValidationError";
  }
}

const PLACEHOLDER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const PLACEHOLDER_REFERENCE_PATTERN = /{{([^{}]*)}}/g;

export function parseAndValidateAiResponse(rawText: string): CommandGenerationContract {
  const parsed = parseJsonObject(rawText);
  const commands = readCommands(parsed);

  return {
    commands: commands.map((command, index) => validateCommandCandidate(command, index)),
  };
}

function parseJsonObject(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    throw new AiResponseValidationError("AI response is not valid JSON");
  }
}

function readCommands(value: unknown): unknown[] {
  const root = asRecord(value, "AI response root must be a JSON object");
  const commands = root.commands;

  if (!Array.isArray(commands)) {
    throw new AiResponseValidationError("AI response must contain a commands array");
  }

  if (commands.length < 1 || commands.length > 3) {
    throw new AiResponseValidationError("commands array must contain 1 to 3 items");
  }

  return commands;
}

function validateCommandCandidate(value: unknown, index: number): CommandCandidateContract {
  const path = `commands[${index}]`;
  const candidate = asRecord(value, `${path} must be an object`);
  const title = readNonEmptyString(candidate.title, `${path}.title`);
  const command = readNonEmptyString(candidate.command, `${path}.command`);
  const description = readNonEmptyString(candidate.description, `${path}.description`);
  const placeholders = readPlaceholders(candidate.placeholders, path);

  validatePlaceholderReferences(command, placeholders, path);

  return {
    title,
    command,
    description,
    placeholders,
  };
}

function readPlaceholders(value: unknown, candidatePath: string): CommandPlaceholderContract[] {
  const path = `${candidatePath}.placeholders`;

  if (!Array.isArray(value)) {
    throw new AiResponseValidationError(`${path} must be an array`);
  }

  return value.map((placeholder, index) => validatePlaceholder(placeholder, `${path}[${index}]`));
}

function validatePlaceholder(value: unknown, path: string): CommandPlaceholderContract {
  const placeholder = asRecord(value, `${path} must be an object`);
  const name = readNonEmptyString(placeholder.name, `${path}.name`);
  const description = readNonEmptyString(placeholder.description, `${path}.description`);

  if (!PLACEHOLDER_NAME_PATTERN.test(name)) {
    throw new AiResponseValidationError(
      `${path}.name may contain only letters, numbers, underscores, or hyphens`,
    );
  }

  return {
    name,
    description,
  };
}

function validatePlaceholderReferences(
  command: string,
  placeholders: CommandPlaceholderContract[],
  candidatePath: string,
): void {
  const declaredNames = new Set(placeholders.map((placeholder) => placeholder.name));
  const usedNames = new Set<string>();

  for (const match of command.matchAll(PLACEHOLDER_REFERENCE_PATTERN)) {
    const name = match[1];

    if (!PLACEHOLDER_NAME_PATTERN.test(name)) {
      throw new AiResponseValidationError(
        `${candidatePath}.command contains invalid placeholder reference {{${name}}}`,
      );
    }

    if (!declaredNames.has(name)) {
      throw new AiResponseValidationError(
        `${candidatePath}.command references undeclared placeholder {{${name}}}`,
      );
    }

    usedNames.add(name);
  }

  for (const declaredName of declaredNames) {
    if (!usedNames.has(declaredName)) {
      throw new AiResponseValidationError(
        `${candidatePath}.placeholders declares unused placeholder ${declaredName}`,
      );
    }
  }
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new AiResponseValidationError(`${path} must be a string`);
  }

  if (value.trim() === "") {
    throw new AiResponseValidationError(`${path} must be a non-empty string`);
  }

  return value;
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AiResponseValidationError(message);
  }

  return value as Record<string, unknown>;
}
