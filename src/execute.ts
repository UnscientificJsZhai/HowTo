import { spawn, type ChildProcess } from "child_process";
import { constants as osConstants } from "os";
import { resolveExecutionShell } from "./shell/execution-environment.js";

type SpawnCommand = (
  command: string,
  args: string[],
  options: {
    stdio: "inherit";
  },
) => ChildProcess;

export interface ExecuteCommandOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawnCommand?: SpawnCommand;
}

export async function executeCommand(
  command: string,
  options: ExecuteCommandOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const shell = resolveExecutionShell(env, platform);
  const spawnCommand = options.spawnCommand ?? spawn;
  const child = spawnCommand(shell, ["-c", command], { stdio: "inherit" });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve(resolveProcessExitCode(code, signal));
    });
  });
}

export function resolveProcessExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === "number") {
    return code;
  }

  if (signal !== null) {
    return 128 + (osConstants.signals[signal] ?? 1);
  }

  return 1;
}
