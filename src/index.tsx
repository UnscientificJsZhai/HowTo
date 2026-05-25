#!/usr/bin/env node

import React from "react";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { CliParseError, parseCliArgs } from "./cli.js";
import { ConfigError, hasExplicitAiProvider, loadConfig } from "./config.js";
import { readUserConfigFile } from "./config-file.js";
import { createCommandProvider } from "./ai/index.js";
import { buildCommandGenerationPrompt, createProviderPromptRequest } from "./prompt.js";
import { parseAndValidateAiResponse } from "./validation/ai-response.js";
import { checkCommandInPath, type CommandPathCheck } from "./validation/command-tool.js";
import { ensureInteractiveTty } from "./ui/tty.js";
import { executeCommand } from "./execute.js";
import { toAppError } from "./errors.js";
import { App } from "./ui/App.js";
import { initializeConfig } from "./init/index.js";

interface CliResult {
  exitCode: number;
}

async function run(argv: string[]): Promise<CliResult> {
  try {
    const parsedCli = parseCliArgs(argv);

    if (parsedCli.options.init) {
      ensureInteractiveTty(process.stdin, process.stdout);
      await initializeConfig({
        cliOptions: parsedCli.options,
        env: process.env,
        input: process.stdin,
        output: process.stdout,
      });
      return { exitCode: 0 };
    }

    const fileConfig = await readUserConfigFile();

    if (parsedCli.question === undefined) {
      throw new CliParseError("missing question");
    }

    if (!hasExplicitAiProvider(parsedCli.options, process.env, fileConfig)) {
      if (parsedCli.options.print) {
        throw new ConfigError(
          "AI provider is not configured. --print cannot run initialization; run howto --init or set --ai-provider, HOWTO_AI_PROVIDER, or ~/.howto/config.json.",
        );
      }

      ensureInteractiveTty(process.stdin, process.stdout);
    }

    const config = hasExplicitAiProvider(parsedCli.options, process.env, fileConfig)
      ? loadConfig(parsedCli.options, process.env, fileConfig)
      : await initializeConfig({
          cliOptions: parsedCli.options,
          env: process.env,
          input: process.stdin,
          output: process.stdout,
        });
    const useCommandPathCheck: CommandPathCheck | undefined =
      parsedCli.useCommand === undefined
        ? undefined
        : checkCommandInPath(parsedCli.useCommand, process.env);

    if (!parsedCli.options.print) {
      ensureInteractiveTty(process.stdin, process.stdout);
    }

    const promptRequest = createProviderPromptRequest({
      question: parsedCli.question,
      arguments: parsedCli.arguments,
      useCommand: parsedCli.useCommand,
      structuredOutput: config.structuredOutput,
    });
    const { systemPrompt, userPrompt } = buildCommandGenerationPrompt(promptRequest);
    const provider = createCommandProvider(config);

    if (parsedCli.options.print) {
      const aiResult = await provider.generateCommands({
        ...promptRequest,
        systemPrompt,
        userPrompt,
      });
      const aiResponse = parseAndValidateAiResponse(aiResult.rawText);
      aiResponse.commands.forEach((candidate) => {
        console.log(candidate.command);
      });
      return { exitCode: 0 };
    }

    if (useCommandPathCheck !== undefined && !useCommandPathCheck.found) {
      console.error(
        `Warning: requested command "${useCommandPathCheck.command}" was not found in PATH. Review before executing any generated command.`,
      );
    }

    let finalCommand: string | undefined;
    let appError: Error | undefined;

    const { waitUntilExit, unmount, clear } = render(
      <App
        provider={provider}
        request={{ ...promptRequest, systemPrompt, userPrompt }}
        useCommand={parsedCli.useCommand}
        onSuccess={(command) => {
          finalCommand = command;
          clear();
          unmount();
        }}
        onError={(error) => {
          appError = error;
          clear();
          unmount();
        }}
      />,
    );

    await waitUntilExit();

    if (appError) {
      throw appError;
    }

    if (finalCommand === undefined) {
      return { exitCode: 1 };
    }

    const exitCode = await executeCommand(finalCommand);

    return { exitCode };
  } catch (error: unknown) {
    const appError = toAppError(error);
    if (appError.message !== "") {
      console.error(appError.message);
    }
    return { exitCode: appError.exitCode };
  }
}

function resolveEntrypointPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolveEntrypointPath(process.argv[1]);

if (isMain) {
  run(process.argv.slice(2))
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error: unknown) => {
      const appError = toAppError(error);
      if (appError.message !== "") {
        console.error(appError.message);
      }
      process.exitCode = appError.exitCode;
    });
}

export { run };
