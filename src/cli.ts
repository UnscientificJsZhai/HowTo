import type { ChatGptLoginOptions } from "./auth/chatgpt/types.js";

export type AiProviderOption = string;
export type ChatGptAction = "login" | "logout" | "status" | "models";

export interface GlobalOptions extends ChatGptLoginOptions {
  print: boolean;
  init?: boolean;
  version?: boolean;
  aiProvider?: AiProviderOption;
  geminiApiKey?: string;
  geminiModel?: string;
  openaiApiUrl?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  chatgptAction?: ChatGptAction;
  chatgptAccount?: string;
  chatgptModel?: string;
  chatgptFast?: string;
  chatgptTimings?: string;
  structuredOutput?: string;
}

export interface ParsedCli {
  options: GlobalOptions;
  useCommand?: string;
  question?: string;
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
  "--chatgpt-account",
  "--chatgpt-model",
  "--chatgpt-fast",
  "--chatgpt-timings",
  "--callback-port",
  "--structured-output",
]);

const CHATGPT_ACTION_OPTIONS = new Map<string, ChatGptAction>([
  ["--chatgpt-login", "login"],
  ["--chatgpt-logout", "logout"],
  ["--chatgpt-status", "status"],
  ["--chatgpt-models", "models"],
]);

const BOOLEAN_OPTIONS = new Set(["--print", "--init", "--version", "--no-browser"]);

export const USAGE = `Usage: howto [options] [use <command>] <question...>
       howto --init [--no-browser] [--callback-port <port>]
       howto --version
       howto --chatgpt-login [--chatgpt-account <account>] [--no-browser] [--callback-port <port>]
       howto --chatgpt-logout|--chatgpt-status|--chatgpt-models [--chatgpt-account <account>]

Options:
  --init
  --version
  --print
  --ai-provider <openai|gemini|chatgpt>
  --gemini-api-key <key>
  --gemini-model <model>
  --openai-api-url <url>
  --openai-api-key <key>
  --openai-model <model>
  --chatgpt-login
  --chatgpt-logout
  --chatgpt-status
  --chatgpt-models
  --chatgpt-account <account>
  --chatgpt-model <model>
  --chatgpt-fast <true|false>   Request Fast (default on; may consume more plan usage)
  --chatgpt-timings <true|false> Show privacy-safe request timings
  --no-browser                 Skip opening the browser for ChatGPT login or --init
  --callback-port <1-65535>     ChatGPT callback port (default: a random available port)
  --structured-output <true|false>

Try: howto list files changed today`;

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

      const chatgptAction = CHATGPT_ACTION_OPTIONS.get(optionName);
      if (chatgptAction !== undefined) {
        if (inlineValue !== undefined) {
          throw new CliParseError(`${optionName} does not accept a value`);
        }
        if (options.chatgptAction !== undefined) {
          throw new CliParseError("only one ChatGPT action may be specified");
        }
        options.chatgptAction = chatgptAction;
        continue;
      }

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

  if (options.version) {
    if (argv.length !== 1) {
      throw new CliParseError("--version must be used alone");
    }

    return { options };
  }

  if (
    (options.noBrowser || options.callbackPort !== undefined) &&
    options.chatgptAction !== "login" &&
    !(options.init && options.chatgptAction === undefined)
  ) {
    throw new CliParseError("--no-browser and --callback-port require --chatgpt-login or --init");
  }

  if (options.chatgptAction !== undefined) {
    const unsupportedOption = Object.keys(options).find(
      (key) =>
        key !== "print" &&
        key !== "chatgptAction" &&
        key !== "chatgptAccount" &&
        !(options.chatgptAction === "login" && (key === "noBrowser" || key === "callbackPort")),
    );
    if (positionals.length > 0 || options.print || unsupportedOption !== undefined) {
      throw new CliParseError(
        "ChatGPT actions accept --chatgpt-account and no question; only login also accepts --no-browser and --callback-port",
      );
    }
    return { options };
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
    case "--chatgpt-account":
      options.chatgptAccount = value;
      return;
    case "--chatgpt-fast":
      options.chatgptFast = value;
      return;
    case "--chatgpt-timings":
      options.chatgptTimings = value;
      return;
    case "--chatgpt-model":
      options.chatgptModel = value;
      return;
    case "--callback-port": {
      const port = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
        throw new CliParseError("--callback-port must be an integer from 1 to 65535");
      }
      options.callbackPort = port;
      return;
    }
    case "--structured-output":
      options.structuredOutput = value;
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
    case "--version":
      options.version = true;
      return;
    case "--no-browser":
      options.noBrowser = true;
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

    return { options };
  }

  if (positionals.length === 0) {
    throw new CliParseError("missing question");
  }

  const isUseMode = positionals[0] === "use";
  if (isUseMode) {
    if (positionals.length === 1) {
      throw new CliParseError("use mode requires <command> and <question>");
    }

    if (positionals.length === 2) {
      throw new CliParseError("use mode requires <question>");
    }
  }

  const question = (isUseMode ? positionals.slice(2) : positionals).join(" ");
  if (question.trim() === "") {
    throw new CliParseError("question must not be blank");
  }

  return {
    options,
    ...(isUseMode ? { useCommand: positionals[1] } : {}),
    question,
  };
}
