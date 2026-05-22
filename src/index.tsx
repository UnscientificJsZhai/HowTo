#!/usr/bin/env node

import React from "react";
import { fileURLToPath } from "node:url";
import { render } from "ink";
import { parseCliArgs } from "./cli.js";
import { loadConfig } from "./config.js";
import { createCommandProvider } from "./ai/index.js";
import { buildCommandGenerationPrompt, createProviderPromptRequest } from "./prompt.js";
import { parseAndValidateAiResponse } from "./validation/ai-response.js";
import { checkCommandInPath, type CommandPathCheck } from "./validation/command-tool.js";
import { ensureInteractiveTty } from "./ui/tty.js";
import { executeCommand } from "./execute.js";
import { toAppError } from "./errors.js";
import { App } from "./ui/App.js";

interface CliResult {
  exitCode: number;
}

async function run(argv: string[]): Promise<CliResult> {
  try {
    const parsedCli = parseCliArgs(argv);
    const config = loadConfig(parsedCli.options, process.env);
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

    console.log("=".repeat(process.stdout.columns || 80));
    console.log();

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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

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
