export type AiProviderOption = string;

export interface GlobalOptions {
  print: boolean;
  init?: boolean;
  aiProvider?: AiProviderOption;
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
}

export interface ParsedCli {
  options: GlobalOptions;
  useCommand?: string;
  question?: string;
  arguments: string[];
}

export class CliParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliParseError";
  }
}

const VALUE_OPTIONS = new Set([
  "--ai-provider",
  "--gemini-api-key",
  "--gemini-model",
  "--openai-api-url",
  "--openai-api-key",
  "--openai-model",
]);

const BOOLEAN_OPTIONS = new Set(["--print", "--init"]);

export const USAGE = `Usage: howto [options] [use <command>] <question> [<argument>...]
       howto --init

Options:
  --init
  --print
  --ai-provider <openai|gemini>
  --gemini-api-key <key>
  --gemini-model <model>
  --openai-api-url <url>
  --openai-api-key <key>
  --openai-model <model>

Try: howto "list files changed today"`;

export function parseCliArgs(argv: string[]): ParsedCli {
  const options: GlobalOptions = { print: false };
  const positionals: string[] = [];
  let parseOptions = true;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (parseOptions && token === "--") {
      parseOptions = false;
      continue;
    }

    if (parseOptions && token.startsWith("--")) {
      const equalIndex = token.indexOf("=");
      const optionName = equalIndex === -1 ? token : token.slice(0, equalIndex);
      const inlineValue = equalIndex === -1 ? undefined : token.slice(equalIndex + 1);

      if (BOOLEAN_OPTIONS.has(optionName)) {
        if (inlineValue !== undefined) {
          throw new CliParseError(`${optionName} does not accept a value`);
        }
        assignBooleanOption(options, optionName);
        continue;
      }

      if (VALUE_OPTIONS.has(optionName)) {
        const value =
          inlineValue !== undefined ? inlineValue : readOptionValue(argv, index, optionName);

        if (inlineValue === undefined) {
          index += 1;
        }

        assignOptionValue(options, optionName, value);
        continue;
      }

      throw new CliParseError(`unknown option: ${optionName}`);
    }

    positionals.push(token);
  }

  return parsePositionals(options, positionals);
}

function readOptionValue(argv: string[], optionIndex: number, optionName: string): string {
  const value = argv[optionIndex + 1];

  if (value === undefined || value === "--" || value.startsWith("--")) {
    throw new CliParseError(`missing value for ${optionName}`);
  }

  return value;
}

function assignOptionValue(options: GlobalOptions, optionName: string, value: string): void {
  switch (optionName) {
    case "--ai-provider":
      options.aiProvider = value;
      return;
    case "--gemini-api-key":
      options.geminiApiKey = value;
      return;
    case "--gemini-model":
      options.geminiModel = value;
      return;
    case "--openai-api-url":
      options.openaiApiUrl = value;
      return;
    case "--openai-api-key":
      options.openaiApiKey = value;
      return;
    case "--openai-model":
      options.openaiModel = value;
      return;
    default:
      throw new CliParseError(`unsupported option: ${optionName}`);
  }
}

function assignBooleanOption(options: GlobalOptions, optionName: string): void {
  switch (optionName) {
    case "--print":
      options.print = true;
      return;
    case "--init":
      options.init = true;
      return;
    default:
      throw new CliParseError(`unsupported option: ${optionName}`);
  }
}

function parsePositionals(options: GlobalOptions, positionals: string[]): ParsedCli {
  if (options.init) {
    if (options.print) {
      throw new CliParseError("--init cannot be combined with --print");
    }

    if (positionals.length > 0) {
      throw new CliParseError("--init cannot be combined with a question or use mode");
    }

    return { options, arguments: [] };
  }

  if (positionals.length === 0) {
    throw new CliParseError("missing question");
  }

  if (positionals[0] === "use") {
    if (positionals.length === 1) {
      throw new CliParseError("use mode requires <command> and <question>");
    }

    if (positionals.length === 2) {
      throw new CliParseError("use mode requires <question>");
    }

    return {
      options,
      useCommand: positionals[1],
      question: positionals[2],
      arguments: positionals.slice(3),
    };
  }

  return {
    options,
    question: positionals[0],
    arguments: positionals.slice(1),
  };
}
