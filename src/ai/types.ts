export interface CommandPlaceholderContract {
  name: string;
  description: string;
}

export interface CommandCandidateContract {
  title: string;
  command: string;
  description: string;
  placeholders: CommandPlaceholderContract[];
}

export interface CommandGenerationContract {
  commands: CommandCandidateContract[];
}

export interface CommandGenerationRequest {
  question: string;
  arguments: string[];
  useCommand?: string;
}

export interface ProviderPromptRequest extends CommandGenerationRequest {
  outputContract: string;
  safetyConstraints: string;
}

export interface GenerateCommandsRequest extends ProviderPromptRequest {
  systemPrompt: string;
  userPrompt: string;
}

export interface GenerateCommandsResult {
  rawText: string;
}

export interface CommandProvider {
  generateCommands(request: GenerateCommandsRequest): Promise<GenerateCommandsResult>;
}
