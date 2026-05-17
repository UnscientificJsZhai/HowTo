import type { CommandGenerationRequest, ProviderPromptRequest } from "./ai/types";

export const OUTPUT_CONTRACT = `Return exactly one JSON object and no natural-language body, markdown, or code fences.
The JSON object must match this schema:
{
  "commands": [
    {
      "title": "non-empty string",
      "command": "non-empty shell command string",
      "description": "non-empty string",
      "placeholders": [
        {
          "name": "non-empty string using only letters, numbers, underscores, or hyphens",
          "description": "non-empty string"
        }
      ]
    }
  ]
}
The commands array must contain 1 to 3 items. Do not return more than 3 candidate commands.
Use placeholders in commands only as {{name}}, and declare every placeholder in the placeholders array.`;

export const SAFETY_CONSTRAINTS = `Prefer read-only, reversible, and low-risk commands.
When a task could involve deletion, overwrite, privilege escalation, network download, or executing downloaded content, prefer a safer alternative or inspection command when possible.
Do not include safety metadata or claim that a command is safe; the local CLI will perform its own validation and dangerous-command checks.`;

export function createProviderPromptRequest(
  request: CommandGenerationRequest,
): ProviderPromptRequest {
  return {
    question: request.question,
    arguments: request.arguments,
    useCommand: request.useCommand,
    outputContract: OUTPUT_CONTRACT,
    safetyConstraints: SAFETY_CONSTRAINTS,
  };
}

export function buildCommandGenerationPrompt(request: ProviderPromptRequest): string {
  const useCommandState =
    request.useCommand === undefined
      ? "No use <command> restriction is active."
      : `The user specified use <command>: ${JSON.stringify(request.useCommand)}. Generate candidate commands only around this command-line tool. Each candidate command must clearly use ${JSON.stringify(request.useCommand)} as the requested tool.`;

  return [
    "You are generating shell command candidates for a CLI named howto.",
    "",
    "User request:",
    `question: ${JSON.stringify(request.question)}`,
    `argument: ${JSON.stringify(request.arguments)}`,
    `useCommand: ${request.useCommand === undefined ? "null" : JSON.stringify(request.useCommand)}`,
    useCommandState,
    "",
    "Output contract:",
    request.outputContract,
    "",
    "Safety constraints:",
    request.safetyConstraints,
  ].join("\n");
}
