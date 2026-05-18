import type { CommandGenerationRequest, ProviderPromptRequest } from "./ai/types.js";

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
Use placeholders in commands only as {{name}}, and declare every placeholder in the placeholders array. User may provide argument. If the user's intent is clear, try to use the provided arguments as parameters in the generated commands instead of placeholders. If the intent is unclear, do not fill them.`;

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

export function buildCommandGenerationPrompt(request: ProviderPromptRequest): {
  systemPrompt: string;
  userPrompt: string;
} {
  const systemLines = [
    "You are generating shell command candidates for a CLI named howto.",
    "",
    "Output contract:",
    request.outputContract,
    "",
    "Safety constraints:",
    request.safetyConstraints,
  ];

  const userLines = ["User request:", `question: ${JSON.stringify(request.question)}`];

  if (request.useCommand !== undefined) {
    userLines.push(`useCommand: ${JSON.stringify(request.useCommand)}`);
    userLines.push(
      `The user specified use <command>: ${JSON.stringify(
        request.useCommand,
      )}. Generate candidate commands only around this command-line tool. Each candidate command must clearly use ${JSON.stringify(
        request.useCommand,
      )} as the requested tool.`,
    );
  }

  if (request.arguments && request.arguments.length > 0) {
    userLines.push(`argument: ${JSON.stringify(request.arguments)}`);
  }

  return {
    systemPrompt: systemLines.join("\n"),
    userPrompt: userLines.join("\n"),
  };
}
