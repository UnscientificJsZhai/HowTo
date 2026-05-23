import { input as promptInput, select } from "@inquirer/prompts";
import type { GlobalOptions } from "../cli.js";
import type { AiProvider, AppConfig, ConfigEnvironment } from "../config.js";
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL, loadConfig } from "../config.js";
import { getConfigFilePath, writeUserConfigFile, type FileConfig } from "../config-file.js";
import type { InteractiveInput, InteractiveOutput } from "../ui/tty.js";
import { InteractionCancelledError } from "../ui/tty.js";

export interface InitializeConfigOptions {
  cliOptions: GlobalOptions;
  env: ConfigEnvironment & NodeJS.ProcessEnv;
  input: InteractiveInput;
  output: InteractiveOutput;
}

export interface InitializationValues {
  provider: AiProvider;
  apiKey: string;
  model: string;
  openaiBaseUrl?: string;
}

export async function initializeConfig({
  cliOptions,
  env,
  input,
  output,
}: InitializeConfigOptions): Promise<AppConfig> {
  try {
    let initializationRows = 0;
    const introduction = "howto needs an AI provider before it can call AI.\n\n";
    output.write(introduction);
    initializationRows += countTerminalRows(output, introduction);

    const values = await collectInitializationValues(input, output);
    initializationRows += countInitializationPromptRows(output, values);
    const fileConfig = createFileConfig(values);
    const configFilePath = getConfigFilePath(env);

    await writeUserConfigFile(fileConfig, configFilePath);
    const savedMessage = `\nSaved howto configuration to ${configFilePath}.\n`;
    output.write(savedMessage);
    initializationRows += countTerminalRows(output, savedMessage);
    await promptInput({ message: "Press Enter to start..." }, { input, output });
    initializationRows += countTerminalRows(output, "✔ Press Enter to start...\n");

    clearInitializationOutput(output, initializationRows);

    return loadConfig(cliOptions, env, fileConfig);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.name === "ExitPromptError" || error.message.includes("force closed"))
    ) {
      throw new InteractionCancelledError();
    }
    throw error;
  }
}

export function clearInitializationOutput(output: InteractiveOutput, rows: number): void {
  if (output.isTTY) {
    output.write(erasePreviousTerminalRows(rows));
  }
}

export function erasePreviousTerminalRows(rows: number): string {
  if (rows <= 0) {
    return "";
  }

  let sequence = "\x1b[2K";
  for (let row = 0; row < rows; row += 1) {
    sequence += "\x1b[1A\x1b[2K";
  }
  return `${sequence}\x1b[G`;
}

export function countInitializationPromptRows(
  output: InteractiveOutput,
  values: InitializationValues,
): number {
  const promptLines =
    values.provider === "gemini"
      ? [
          "✔ Choose AI provider: gemini",
          `✔ Gemini API key: ${values.apiKey}`,
          `✔ Gemini model: ${values.model}`,
        ]
      : [
          "✔ Choose AI provider: openai",
          `✔ OpenAI API key (optional): ${values.apiKey}`,
          `✔ OpenAI model: ${values.model}`,
          `✔ OpenAI base URL (optional, Enter for official default): ${values.openaiBaseUrl ?? ""}`,
        ];

  return promptLines.reduce((rows, line) => rows + countTerminalRows(output, `${line}\n`), 0);
}

export function countTerminalRows(output: InteractiveOutput, text: string): number {
  const columns = getOutputColumns(output);
  const lines = text.split("\n");
  let rows = 0;

  lines.forEach((line, index) => {
    const isFinalLine = index === lines.length - 1;
    if (isFinalLine && line === "") {
      return;
    }

    rows += Math.max(1, Math.ceil(line.length / columns));
  });

  return rows;
}

function getOutputColumns(output: InteractiveOutput): number {
  const { columns } = output as InteractiveOutput & { columns?: unknown };
  return typeof columns === "number" && columns > 0 ? columns : 80;
}

export function createFileConfig(values: InitializationValues): FileConfig {
  if (values.provider === "gemini") {
    return {
      aiProvider: "gemini",
      geminiApiKey: values.apiKey,
      geminiModel: values.model,
    };
  }

  const config: FileConfig = {
    aiProvider: "openai",
    openaiApiKey: values.apiKey,
    openaiModel: values.model,
  };

  if (values.openaiBaseUrl !== undefined) {
    config.openaiApiUrl = values.openaiBaseUrl;
  }

  return config;
}

async function collectInitializationValues(
  input: InteractiveInput,
  output: InteractiveOutput,
): Promise<InitializationValues> {
  const provider = await select(
    {
      message: "Choose AI provider:",
      choices: [
        { name: "openai", value: "openai" as const },
        { name: "gemini", value: "gemini" as const },
      ],
    },
    { input, output },
  );

  if (provider === "gemini") {
    const apiKey = await promptInput(
      {
        message: "Gemini API key:",
        validate: (val) => (val.trim() !== "" ? true : "This value is required."),
      },
      { input, output },
    );
    const model = await promptInput(
      {
        message: "Gemini model:",
        default: DEFAULT_GEMINI_MODEL,
      },
      { input, output },
    );
    return { provider, apiKey, model };
  }

  const apiKey = await promptInput(
    {
      message: "OpenAI API key (optional):",
    },
    { input, output },
  );
  const model = await promptInput(
    {
      message: "OpenAI model:",
      default: DEFAULT_OPENAI_MODEL,
    },
    { input, output },
  );
  const baseUrl = await promptInput(
    {
      message: "OpenAI base URL (optional, Enter for official default):",
    },
    { input, output },
  );
  return {
    provider,
    apiKey,
    model,
    openaiBaseUrl: baseUrl.trim() === "" ? undefined : baseUrl,
  };
}
