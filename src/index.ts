#!/usr/bin/env node

import { parseCliArgs } from "./cli";
import { loadConfig } from "./config";
import { createCommandProvider } from "./ai";
import { buildCommandGenerationPrompt, createProviderPromptRequest } from "./prompt";
import { parseAndValidateAiResponse } from "./validation/ai-response";
import {
  checkCommandInPath,
  type CommandPathCheck,
  validateUseCommandCandidates,
} from "./validation/command-tool";
import { ensureInteractiveTty, selectCommandCandidate } from "./ui/interactive";
import { confirmFinalCommand } from "./ui/confirm";
import { resolveCommandPlaceholders } from "./ui/placeholders";
import { detectDangerousCommand } from "./safety/dangerous-command";
import { confirmDangerousCommand } from "./ui/confirm";
import { executeCommand } from "./execute";
import { toAppError } from "./errors";

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
    const prompt = buildCommandGenerationPrompt(promptRequest);
    const provider = createCommandProvider(config);
    const aiResult = await provider.generateCommands({
      ...promptRequest,
      prompt,
    });
    const aiResponse = parseAndValidateAiResponse(aiResult.rawText);
    validateUseCommandCandidates(aiResponse, parsedCli.useCommand);

    if (parsedCli.options.print) {
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

    const selectedCandidate = await selectCommandCandidate(aiResponse.commands);
    const finalCommand = await resolveCommandPlaceholders(selectedCandidate);
    const dangerousCommandMatch = detectDangerousCommand(finalCommand);

    if (dangerousCommandMatch === undefined) {
      await confirmFinalCommand(finalCommand);
    } else {
      await confirmDangerousCommand(finalCommand, dangerousCommandMatch);
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

if (require.main === module) {
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
