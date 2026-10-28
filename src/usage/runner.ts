import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { onExit as signalExit } from "signal-exit";
import { validateUsageArgumentList, validateUsageLookupArguments } from "./arguments.js";
import { sanitizeUsageLookupResult, UsageOutputCapture } from "./output.js";
import type { UsageLookupResult, UsageLookupStatus } from "./types.js";

export interface ExecuteUsageLookupOptions {
  requested: unknown;
  executable: string;
  argv0?: string;
  args: string[];
  signal: AbortSignal;
  getExecutionPolicy: () => "execute" | "print";
  /** 启动前同步检查输入；省略时沿用权限读取，不用于运行中的权限通知。 */
  checkExecutionPolicy?: () => "execute" | "print";
  subscribeExecutionPolicy: (listener: () => void) => () => void;
  knownCredentials?: readonly string[];
  timeoutMs?: number;
}

export function resolveUsageExecutable(useCommand: string): string | null {
  if (useCommand === "" || useCommand.includes("\0")) return null;
  const candidates = useCommand.includes("/")
    ? [resolve(useCommand)]
    : (process.env["PATH"]?.split(delimiter) ?? []).map((directory) =>
        resolve(directory, useCommand),
      );
  for (const candidate of candidates) {
    try {
      const path = realpathSync(candidate);
      if (isExecutable(path)) return path;
    } catch {
      // 路径缺失、循环链接或权限不足均视为不可执行，不回传底层异常。
    }
  }
  return null;
}

export function createUsageLookupResult(
  requested: unknown,
  status: UsageLookupStatus,
): UsageLookupResult {
  return {
    requested,
    actualCommand: null,
    status,
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    credentialsRedacted: false,
  };
}

export function executeUsageLookup(options: ExecuteUsageLookupOptions): Promise<UsageLookupResult> {
  const result = createUsageLookupResult(options.requested, "spawn_failed");
  const sanitizedResult = () => sanitizeUsageLookupResult(result, options.knownCredentials);
  let args: string[];
  try {
    validateUsageLookupArguments(options.requested);
    args = validateUsageArgumentList(options.args);
    if (options.argv0 !== undefined) validateUsageArgumentList([options.argv0]);
  } catch {
    result.status = "invalid_arguments";
    return Promise.resolve(sanitizedResult());
  }
  if (!isAbsolute(options.executable) || !isExecutable(options.executable)) {
    result.status = "not_found";
    return Promise.resolve(sanitizedResult());
  }

  return new Promise((resolveResult) => {
    const stdout = new UsageOutputCapture(options.knownCredentials);
    const stderr = new UsageOutputCapture(options.knownCredentials);
    let child: ChildProcess | undefined;
    let stopStatus: "timeout" | "cancelled" | "permission_revoked" | undefined;
    let completed = false;
    let closed = false;
    let exited = false;
    let cleaning = false;
    let cleanupFinished = false;
    let timeout: ReturnType<typeof setTimeout> | undefined = undefined;
    let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = () => {};
    let removeExitHook: (() => void) | undefined;

    const cleanupListeners = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (cleanupTimeout !== undefined) clearTimeout(cleanupTimeout);
      options.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      removeExitHook?.();
      removeExitHook = undefined;
    };

    const finish = () => {
      if (completed) return;
      completed = true;
      cleanupListeners();
      const capturedStdout = stdout.finish();
      const capturedStderr = stderr.finish();
      result.stdout = capturedStdout.text;
      result.stderr = capturedStderr.text;
      result.stdoutTruncated = capturedStdout.truncated;
      result.stderrTruncated = capturedStderr.truncated;
      result.credentialsRedacted =
        capturedStdout.credentialsRedacted || capturedStderr.credentialsRedacted;
      if (stopStatus !== undefined) result.status = stopStatus;
      resolveResult(sanitizedResult());
    };

    const finishIfClean = () => {
      if (!closed || completed) return;
      if (processGroupExists(child?.pid) && !cleanupFinished) {
        cleanProcessGroup();
        return;
      }
      finish();
    };

    const finishCleanup = () => {
      cleanupFinished = true;
      // 后代可能脱离进程组却仍持有 pipe；停止查询后不再等待它释放 fd。
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (closed || exited) finish();
    };

    const cleanProcessGroup = () => {
      if (cleaning || completed || child?.pid === undefined) return;
      cleaning = true;
      signalProcessGroup(child.pid, "SIGTERM");
      if (!processGroupExists(child.pid)) {
        finishCleanup();
        return;
      }
      cleanupTimeout = setTimeout(() => {
        if (processGroupExists(child?.pid)) signalProcessGroup(child!.pid!, "SIGKILL");
        finishCleanup();
      }, 500);
    };

    const stop = (status: "timeout" | "cancelled" | "permission_revoked") => {
      if (completed) return;
      if (stopStatus === undefined || status === "cancelled") stopStatus = status;
      if (status === "timeout") result.timedOut = true;
      if (child !== undefined) cleanProcessGroup();
    };
    const onAbort = () => stop("cancelled");
    const onPolicyChange = () => {
      if (options.getExecutionPolicy() === "print") stop("permission_revoked");
    };

    try {
      options.signal.addEventListener("abort", onAbort, { once: true });
      unsubscribe = options.subscribeExecutionPolicy(onPolicyChange);
      if (options.signal.aborted) stop("cancelled");
      // 必须最后同步复查；从复查到 spawn 不经过 await，避免待处理输入使检查失败后仍启动。
      if ((options.checkExecutionPolicy?.() ?? options.getExecutionPolicy()) === "print")
        stop("permission_revoked");
    } catch (error) {
      cleanupListeners();
      throw error;
    }
    if (stopStatus !== undefined || options.signal.aborted) {
      if (options.signal.aborted) stop("cancelled");
      finish();
      return;
    }
    try {
      // 进程退出不再运行 500ms 定时器；同步清理本查询组，保留父进程的原退出语义。
      removeExitHook = signalExit(() => {
        if (child?.pid !== undefined) signalProcessGroup(child.pid, "SIGKILL");
      });
      child = spawn(options.executable, args, {
        // 保留原调用名，避免 realpath 后的 BusyBox 等多调用程序改变分派语义。
        argv0: options.argv0 ?? options.executable,
        cwd: process.cwd(),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch {
      finish();
      return;
    }
    if (child.pid !== undefined) {
      result.actualCommand = {
        executable: options.executable,
        args,
        ...(options.argv0 === undefined ? {} : { argv0: options.argv0 }),
      };
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.write(chunk));
    child.once("error", () => {
      result.status = "spawn_failed";
      if (child?.pid !== undefined) cleanProcessGroup();
    });
    child.once("exit", (code) => {
      exited = true;
      result.exitCode = code;
      result.status = code === 0 ? "success" : "nonzero_exit";
      if (processGroupExists(child?.pid)) cleanProcessGroup();
    });
    child.once("close", () => {
      closed = true;
      finishIfClean();
    });
    timeout = setTimeout(() => stop("timeout"), options.timeoutMs ?? 10_000);
  });
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // 自然退出与进程组信号存在竞态；组已消失即无需继续处理。
  }
}
