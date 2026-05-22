import { accessSync, constants } from "fs";
import { delimiter, isAbsolute, join } from "path";

import type { CommandGenerationContract } from "../ai/types.js";
import { AiResponseValidationError } from "./ai-response.js";

export interface CommandPathCheck {
  command: string;
  found: boolean;
  resolvedPath?: string;
}

const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=.*$/;
const SHELL_WRAPPERS = new Set(["sh", "bash", "zsh", "fish", "csh", "ksh"]);

export function checkCommandInPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): CommandPathCheck {
  const candidates = buildPathCandidates(command, env);

  for (const candidate of candidates) {
    if (isExecutable(candidate)) {
      return {
        command,
        found: true,
        resolvedPath: candidate,
      };
    }
  }

  return {
    command,
    found: false,
  };
}

export function validateUseCommandCandidates(
  response: CommandGenerationContract,
  useCommand: string | undefined,
): void {
  if (useCommand === undefined) {
    return;
  }

  response.commands.forEach((candidate, index) => {
    if (!candidateUsesRequestedCommand(candidate.command, useCommand)) {
      throw new AiResponseValidationError(
        `commands[${index}].command must use ${useCommand} as the first executable token after optional environment assignments, sudo, or env`,
      );
    }
  });
}

export function candidateUsesRequestedCommand(
  commandText: string,
  requestedCommand: string,
): boolean {
  const tokens = tokenizeShellPrefix(commandText);

  if (tokens === undefined || tokens.length === 0) {
    return false;
  }

  const executable = findFirstExecutableToken(tokens);

  if (executable === undefined) {
    return false;
  }

  if (SHELL_WRAPPERS.has(executable)) {
    return false;
  }

  return executable === requestedCommand;
}

function buildPathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  if (command.includes("/") || isAbsolute(command)) {
    return [command];
  }

  const pathValue = env.PATH ?? "";
  const pathExt = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM") : "";
  const extensions = process.platform === "win32" ? pathExt.split(";").filter(Boolean) : [""];
  const candidates: string[] = [];

  for (const directory of pathValue.split(delimiter)) {
    if (directory === "") {
      continue;
    }

    for (const extension of extensions) {
      candidates.push(
        command.toLowerCase().endsWith(extension.toLowerCase())
          ? join(directory, command)
          : join(directory, `${command}${extension}`),
      );
    }
  }

  return candidates;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findFirstExecutableToken(tokens: string[]): string | undefined {
  let index = 0;

  while (index < tokens.length && ENV_ASSIGNMENT_PATTERN.test(tokens[index])) {
    index += 1;
  }

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === "sudo") {
      index = skipSudo(tokens, index + 1);
      continue;
    }

    if (token === "env") {
      index = skipEnv(tokens, index + 1);
      continue;
    }

    if (ENV_ASSIGNMENT_PATTERN.test(token)) {
      index += 1;
      continue;
    }

    return token;
  }

  return undefined;
}

function skipSudo(tokens: string[], startIndex: number): number {
  let index = startIndex;

  while (index < tokens.length && tokens[index].startsWith("-")) {
    index += 1;
  }

  return index;
}

function skipEnv(tokens: string[], startIndex: number): number {
  let index = startIndex;

  while (index < tokens.length) {
    const token = tokens[index];

    if (ENV_ASSIGNMENT_PATTERN.test(token)) {
      index += 1;
      continue;
    }

    if (token.startsWith("-")) {
      index += 1;
      if ((token === "-u" || token === "--unset") && index < tokens.length) {
        index += 1;
      }
      continue;
    }

    return index;
  }

  return index;
}

function tokenizeShellPrefix(commandText: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < commandText.length; index += 1) {
    const character = commandText[index];

    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && quote === '"' && index + 1 < commandText.length) {
        index += 1;
        current += commandText[index];
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }

    if (character === "\\") {
      if (index + 1 >= commandText.length) {
        return undefined;
      }
      index += 1;
      current += commandText[index];
      continue;
    }

    if (/\s/.test(character)) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (isShellControlOperator(character)) {
      if (current !== "") {
        tokens.push(current);
      }
      break;
    }

    current += character;
  }

  if (quote !== undefined) {
    return undefined;
  }

  if (current !== "") {
    tokens.push(current);
  }

  return tokens;
}

function isShellControlOperator(character: string): boolean {
  return (
    character === "|" ||
    character === ";" ||
    character === "&" ||
    character === "(" ||
    character === ")"
  );
}
