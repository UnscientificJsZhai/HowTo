import type {
  CommandCandidateContract,
  CommandProvider,
  GenerateCommandsRequest,
} from "../ai/types.js";
import { parseAndValidateAiResponse } from "./ai-response.js";
import { validateUseCommandCandidates } from "./command-tool.js";

export async function generateValidatedCommandCandidates(
  provider: CommandProvider,
  request: GenerateCommandsRequest,
): Promise<CommandCandidateContract[]> {
  const result = await provider.generateCommands(request);
  const response = parseAndValidateAiResponse(result.rawText);
  validateUseCommandCandidates(response, request.useCommand);

  return response.commands;
}
