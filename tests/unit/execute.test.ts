import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";

import { executeCommand, resolveProcessExitCode } from "../../src/execute.js";

test("executeCommand 将原命令传给非登录 POSIX shell 并继承 stdio", async () => {
  const child = new EventEmitter() as ChildProcess;
  let receivedCommand: string | undefined;
  let receivedArgs: string[] | undefined;
  let receivedOptions:
    | {
        stdio: "inherit";
      }
    | undefined;

  const execution = executeCommand("echo hello", {
    env: { SHELL: "/bin/zsh" },
    platform: "darwin",
    spawnCommand(command, args, options) {
      receivedCommand = command;
      receivedArgs = Array.isArray(args) ? args : undefined;
      receivedOptions = options;
      return child;
    },
  });

  child.emit("close", 0, null);

  assert.equal(await execution, 0);
  assert.equal(receivedCommand, "/bin/zsh");
  assert.deepEqual(receivedArgs, ["-c", "echo hello"]);
  assert.deepEqual(receivedOptions, {
    stdio: "inherit",
  });
});

test("executeCommand falls back to /bin/sh when SHELL is empty on Unix", async () => {
  const child = new EventEmitter() as ChildProcess;
  let receivedCommand: string | undefined;
  let receivedArgs: string[] | undefined;

  const execution = executeCommand("echo hello", {
    env: {},
    platform: "linux",
    spawnCommand(command, args) {
      receivedCommand = command;
      receivedArgs = Array.isArray(args) ? args : undefined;
      return child;
    },
  });

  child.emit("close", 0, null);

  assert.equal(await execution, 0);
  assert.equal(receivedCommand, "/bin/sh");
  assert.deepEqual(receivedArgs, ["-c", "echo hello"]);
});

test("executeCommand keeps spawn-shell fallback on Windows", async () => {
  const child = new EventEmitter() as ChildProcess;
  let receivedCommand: string | undefined;
  let receivedOptions:
    | {
        shell?: string | boolean;
        stdio: "inherit";
      }
    | undefined;

  const execution = executeCommand("echo hello", {
    env: { SHELL: "C:\\Windows\\System32\\cmd.exe" },
    platform: "win32",
    spawnCommand(command, args) {
      receivedCommand = command;
      receivedOptions = Array.isArray(args) ? undefined : args;
      return child;
    },
  });

  child.emit("close", 0, null);

  assert.equal(await execution, 0);
  assert.equal(receivedCommand, "echo hello");
  assert.deepEqual(receivedOptions, {
    shell: "C:\\Windows\\System32\\cmd.exe",
    stdio: "inherit",
  });
});

test("executeCommand returns the child process exit code", async () => {
  const child = new EventEmitter() as ChildProcess;
  const execution = executeCommand("exit 7", {
    spawnCommand() {
      return child;
    },
  });

  child.emit("close", 7, null);

  assert.equal(await execution, 7);
});

test("executeCommand rejects when spawning fails", async () => {
  const child = new EventEmitter() as ChildProcess;
  const execution = executeCommand("missing-command", {
    spawnCommand() {
      return child;
    },
  });

  child.emit("error", new Error("spawn failed"));

  await assert.rejects(execution, /spawn failed/);
});

test("resolveProcessExitCode converts signals to non-success exit codes", () => {
  assert.equal(resolveProcessExitCode(null, "SIGTERM"), 143);
  assert.equal(resolveProcessExitCode(null, "SIGINT"), 130);
});

test("resolveProcessExitCode falls back to 1 when no code or signal is available", () => {
  assert.equal(resolveProcessExitCode(null, null), 1);
});

const realShellCases = [
  { name: "普通命令", command: "/usr/bin/printf A", stdout: "A", stderr: "", exitCode: 0 },
  {
    name: "成功条件后的命令",
    command: "/usr/bin/printf A && /usr/bin/printf B",
    stdout: "AB",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "失败条件后的命令不执行",
    command: "/usr/bin/false && /usr/bin/printf skipped",
    stdout: "",
    stderr: "",
    exitCode: 1,
  },
  {
    name: "失败后的回退命令",
    command: "/usr/bin/false || /usr/bin/printf fallback",
    stdout: "fallback",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "管道",
    command: "/usr/bin/printf A | /usr/bin/tr A B",
    stdout: "B",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "前置环境变量赋值",
    command: "HOWTO_EXECUTION_INLINE=assigned /bin/sh -c 'printf %s \"$HOWTO_EXECUTION_INLINE\"'",
    stdout: "assigned",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "内建退出命令",
    command: "exit 7",
    stdout: "",
    stderr: "",
    exitCode: 7,
  },
  {
    name: "引号、换行、错误输出和最终退出码",
    command: "printf '%s' 'quoted value';\nprintf '%s' error >&2; exit 9",
    stdout: "quoted value",
    stderr: "error",
    exitCode: 9,
  },
];

for (const { name, command, ...expected } of realShellCases) {
  test(`executeCommand 真实 shell 保持${name}语义`, posixTestOptions(), async (t) => {
    const directory = await createExecutionDirectory(t);
    assert.deepEqual(await runRealCommand(t, command, directory), expected);
  });
}

test("executeCommand 真实 shell 将重定向限制在测试目录", posixTestOptions(), async (t) => {
  const directory = await createExecutionDirectory(t);
  assert.deepEqual(await runRealCommand(t, "printf %s redirected > result.txt", directory), {
    stdout: "",
    stderr: "",
    exitCode: 0,
  });
  assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "redirected");
});

test("executeCommand 继承环境和目录且不额外加载登录 profile", posixTestOptions(), async (t) => {
  const directory = await createExecutionDirectory(t);
  await writeFile(
    join(directory, ".profile"),
    "HOWTO_EXECUTION_VALUE=from-login-profile\nexport HOWTO_EXECUTION_VALUE\ncd /\n",
    "utf8",
  );

  assert.deepEqual(
    await runRealCommand(t, 'printf \'%s\\n\' "$PWD" "$HOWTO_EXECUTION_VALUE"', directory),
    { stdout: `${directory}\ninherited-value\n`, stderr: "", exitCode: 0 },
  );
});

function posixTestOptions(): { skip: boolean; timeout: number } {
  return { skip: process.platform === "win32", timeout: 8_000 };
}

async function createExecutionDirectory(t: TestContext): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "howto-execution-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function runRealCommand(
  t: TestContext,
  command: string,
  directory: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const moduleUrl = new URL("../../src/execute.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { executeCommand } from ${JSON.stringify(moduleUrl)}; process.exitCode = await executeCommand(${JSON.stringify(command)});`,
    ],
    {
      cwd: directory,
      env: {
        HOME: directory,
        PATH: "/usr/bin:/bin",
        SHELL: "/bin/sh",
        HOWTO_EXECUTION_VALUE: "inherited-value",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let closed = false;
  let timedOut = false;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  const stopChild = () => {
    if (closed || child.pid === undefined) return;
    try {
      // 子进程独占测试进程组，超时后连同其 shell 子进程一起清理。
      process.kill(-child.pid, "SIGKILL");
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  };
  t.after(stopChild);
  const timeout = setTimeout(() => {
    timedOut = true;
    stopChild();
  }, 5_000);

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        closed = true;
        resolve(code);
      });
    });
    assert.equal(timedOut, false, "真实 shell 测试超时");
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timeout);
    stopChild();
  }
}
