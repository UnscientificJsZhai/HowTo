#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliParseError, parseCliArgs } from "./cli.js";
import { ConfigError, hasExplicitAiProvider, loadConfig } from "./config.js";
import { readUserConfigFile } from "./config-file.js";
import { createCommandProvider } from "./ai/index.js";
import { buildCommandGenerationPrompt, createProviderPromptRequest } from "./prompt.js";
import { checkCommandInPath, type CommandPathCheck } from "./validation/command-tool.js";
import { generateValidatedCommandCandidates } from "./validation/generated-commands.js";
import { ensureInteractiveTty } from "./ui/tty.js";
import { toAppError } from "./errors.js";
import type { InteractiveSession } from "./ui/interactive-session.js";
import { renderTerminalSafeText } from "./terminal-text.js";
import { readPackageVersion } from "./version.js";
import { assertSupportedPlatform, resolveExecutionShell } from "./shell/execution-environment.js";

interface CliResult {
  exitCode: number;
}

async function run(argv: string[]): Promise<CliResult> {
  let session: InteractiveSession | undefined;
  const getSession = async () => {
    ensureInteractiveTty(process.stdin, process.stdout);
    const { createInteractiveSession } = await import("./ui/interactive-session.js");
    session ??= createInteractiveSession({ input: process.stdin, output: process.stdout });
    return session;
  };
  try {
    assertSupportedPlatform();
    const parsedCli = parseCliArgs(argv);

    if (parsedCli.options.version) {
      console.log(readPackageVersion());
      return { exitCode: 0 };
    }

    if (parsedCli.options.init) {
      ensureInteractiveTty(process.stdin, process.stdout);
      const { initializeConfig } = await import("./init/index.js");
      await initializeConfig({
        cliOptions: parsedCli.options,
        env: process.env,
        session: await getSession(),
      });
      return { exitCode: 0 };
    }

    if (!parsedCli.options.print) {
      resolveExecutionShell();
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
      : await (
          await import("./init/index.js")
        ).initializeConfig({
          cliOptions: parsedCli.options,
          env: process.env,
          session: await getSession(),
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
      const candidates = await generateValidatedCommandCandidates(provider, {
        ...promptRequest,
        systemPrompt,
        userPrompt,
      });
      candidates.forEach((candidate) => {
        console.log(candidate.command);
      });
      return { exitCode: 0 };
    }

    if (useCommandPathCheck !== undefined && !useCommandPathCheck.found) {
      console.error(
        `Warning: requested command "${renderTerminalSafeText(useCommandPathCheck.command)}" was not found in PATH. Review before executing any generated command.`,
      );
    }

    const { runInteractiveCommand } = await import("./ui/run-interactive-command.js");
    const exitCode = await runInteractiveCommand({
      session: await getSession(),
      provider,
      request: { ...promptRequest, systemPrompt, userPrompt },
    });
    return { exitCode };
  } catch (error: unknown) {
    const appError = toAppError(error);
    if (appError.message !== "") {
      console.error(appError.message);
    }
    return { exitCode: appError.exitCode };
  } finally {
    session?.dispose();
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
  let outputFailed = false;
  process.stdout.on("error", () => {
    if (!outputFailed) {
      outputFailed = true;
      console.error("Error: failed to write standard output.");
    }
    process.exitCode = 1;
  });
  run(process.argv.slice(2))
    .then((result) => {
      process.exitCode = outputFailed ? 1 : result.exitCode;
    })
    .catch((error: unknown) => {
      const appError = toAppError(error);
      if (appError.message !== "") {
        console.error(appError.message);
      }
      process.exitCode = outputFailed ? 1 : appError.exitCode;
    });
}

export { run };
