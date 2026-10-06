import { posix } from "node:path";

const SUPPORTED_SHELLS = new Set(["sh", "bash", "zsh"]);

export class UnsupportedEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedEnvironmentError";
  }
}

export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin" && platform !== "linux") {
    throw new UnsupportedEnvironmentError(
      "howto only supports macOS and Linux. Native Windows is not supported; use Linux Node.js inside WSL.",
    );
  }
}

export function resolveExecutionShell(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  assertSupportedPlatform(platform);
  const shell = env.SHELL && env.SHELL.trim() !== "" ? env.SHELL : "/bin/sh";
  const name = posix.basename(shell);

  // 按调用名称检查，保留 Linux /bin/sh 指向 dash 等系统实现的兼容性。
  // 只接受裸名称或绝对路径，不解释附加参数，也不使用相对路径查找解释器。
  if (
    !SUPPORTED_SHELLS.has(name) ||
    (shell !== name && (!posix.isAbsolute(shell) || !shell.endsWith(`/${name}`)))
  ) {
    throw new UnsupportedEnvironmentError(
      "howto only executes commands with sh, bash, or zsh. Set SHELL to a supported shell name or absolute executable path.",
    );
  }

  return shell;
}
