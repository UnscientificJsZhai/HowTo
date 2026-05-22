import { spawn, type ChildProcess } from "child_process";
import { constants as osConstants } from "os";

type SpawnCommand = (
  command: string,
  options: {
    shell: string | boolean;
    stdio: "inherit";
  },
) => ChildProcess;

export interface ExecuteCommandOptions {
  env?: NodeJS.ProcessEnv;
  spawnCommand?: SpawnCommand;
}

export async function executeCommand(
  command: string,
  options: ExecuteCommandOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const spawnCommand = options.spawnCommand ?? spawn;
  const child = spawnCommand(command, {
    shell: env.SHELL || true,
    stdio: "inherit",
  });

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
