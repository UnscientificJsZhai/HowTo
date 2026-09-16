import React from "react";
import { render, type Instance } from "ink";
import type { GlobalOptions } from "../cli.js";
import type { AiProvider, AppConfig, ConfigEnvironment } from "../config.js";
import { loadConfig } from "../config.js";
import { getConfigFilePath, writeUserConfigFile, type FileConfig } from "../config-file.js";
import type { InteractiveSession } from "../ui/interactive-session.js";
import { InteractiveSessionProvider } from "../ui/InteractiveSessionProvider.js";
import type { InteractiveOutput } from "../ui/tty.js";
import { InteractionCancelledError } from "../ui/tty.js";
import { InitializationApp } from "./InitializationApp.js";

export interface InitializeConfigOptions {
  cliOptions: GlobalOptions;
  env: ConfigEnvironment & NodeJS.ProcessEnv;
  session: InteractiveSession;
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
  session,
}: InitializeConfigOptions): Promise<AppConfig> {
  return await new Promise<AppConfig>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};

    const settle = (result: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      session.suspendViewInput();
      unsubscribe();
      const exitPromise = instance.waitUntilExit();
      instance.clear();
      instance.unmount();
      void exitPromise.then(result, result);
    };

    const instance: Instance = render(
      <InteractiveSessionProvider session={session}>
        <InitializationApp
          onSubmit={async (values) => {
            return validateAndPersistInitializationConfig(values, cliOptions, env);
          }}
          onComplete={(config) => {
            settle(() => {
              resolve(config);
            });
          }}
          onCancel={() => {
            settle(() => {
              reject(new InteractionCancelledError());
            });
          }}
          onError={(error) => {
            settle(() => {
              reject(error);
            });
          }}
        />
      </InteractiveSessionProvider>,
      {
        stdin: session.input,
        stdout: session.output,
        exitOnCtrlC: false,
        // 会话已确认 TTY，避免 CI 环境关闭 Ink 的实时渲染。
        interactive: true,
      },
    );
    unsubscribe = session.subscribeFailure((error) => settle(() => reject(error)));
  });
}

export async function validateAndPersistInitializationConfig(
  values: InitializationValues,
  cliOptions: GlobalOptions,
  env: ConfigEnvironment & NodeJS.ProcessEnv,
): Promise<AppConfig> {
  const fileConfig = createFileConfig(values);
  const config = loadConfig(cliOptions, env, fileConfig);
  const configFilePath = getConfigFilePath(env);

  await writeUserConfigFile(fileConfig, configFilePath);
  return config;
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

  if (values.openaiBaseUrl !== undefined && values.openaiBaseUrl.trim() !== "") {
    config.openaiApiUrl = values.openaiBaseUrl;
  }

  return config;
}
