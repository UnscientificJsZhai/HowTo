import { accessSync, constants } from "fs";
import { delimiter, isAbsolute, join } from "path";

import type { CommandGenerationContract } from "../ai/types.js";
import {
  isShellExecutable,
  parseShellCommand,
  resolveCommandPrefix,
} from "../shell/command-analysis.js";
import { AiResponseValidationError } from "./ai-response.js";

export interface CommandPathCheck {
  command: string;
  found: boolean;
  resolvedPath?: string;
}

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
    if (
      !candidateUsesRequestedCommand(
        candidate.command,
        useCommand,
        candidate.placeholders.map((placeholder) => placeholder.name),
      )
    ) {
      throw new AiResponseValidationError(
        `commands[${index}].command must use ${useCommand} as the first executable token after optional environment assignments, sudo, or env`,
      );
    }
  });
}

export function candidateUsesRequestedCommand(
  commandText: string,
  requestedCommand: string,
  declaredPlaceholderNames: readonly string[] = [],
): boolean {
  const declaredNames = new Set(declaredPlaceholderNames);
  const placeholders: Array<{ start: number; end: number }> = [];
  // 仅修改分析副本，等长替身让解析结果的位置仍对应原始模板。
  const analysisText = commandText.replace(
    /{{([A-Za-z0-9_-]+)}}/g,
    (reference: string, name: string, start: number) => {
      if (!declaredNames.has(name)) return reference;
      placeholders.push({ start, end: start + reference.length });
      return "x".repeat(reference.length);
    },
  );
  const parsed = parseShellCommand(analysisText);
  if (parsed.kind === "unsupported") return false;

  const firstCommand = parsed.commands[0];
  if (firstCommand === undefined) return false;
  const prefix = resolveCommandPrefix(firstCommand.words);
  if (prefix.kind === "unsupported" || isShellExecutable(prefix.executable.value)) return false;
  // 首工具本身及之前的模板可能改变前缀边界，不能靠替身证明工具身份。
  if (placeholders.some((placeholder) => placeholder.start < prefix.executable.end)) return false;

  return prefix.executable.value === requestedCommand;
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
