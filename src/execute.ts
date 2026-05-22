import { spawn, type ChildProcess } from "child_process";
import { constants as osConstants } from "os";

type SpawnCommand = (
  command: string,
  args:
    | string[]
    | {
        shell?: string | boolean;
        stdio: "inherit";
      },
  options?: {
    shell?: string | boolean;
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
  const spawnCommand = options.spawnCommand ?? spawnCommandWithNodeSpawn;
  const child =
    platform === "win32"
      ? spawnCommand(command, { shell: env.SHELL || true, stdio: "inherit" }, { stdio: "inherit" })
      : spawnCommand(resolveShell(env), ["-lc", `exec ${command}`], { stdio: "inherit" });

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

function resolveShell(env: NodeJS.ProcessEnv): string {
  return env.SHELL && env.SHELL.trim() !== "" ? env.SHELL : "/bin/sh";
}

const spawnCommandWithNodeSpawn: SpawnCommand = (command, args, options) => {
  if (Array.isArray(args)) {
    return options === undefined ? spawn(command, args) : spawn(command, args, options);
  }

  return spawn(command, args);
};
