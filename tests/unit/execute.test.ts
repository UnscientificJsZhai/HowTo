import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

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

test("executeCommand 拒绝在 Windows 上执行", async () => {
  await assert.rejects(
    executeCommand("echo hello", {
      env: { SHELL: "C:\\Windows\\System32\\cmd.exe" },
      platform: "win32",
      spawnCommand() {
        assert.fail("不支持的平台不得启动子进程");
      },
    }),
    /only supports macOS and Linux/,
  );
});

test("executeCommand returns the child process exit code", async () => {
  const child = new EventEmitter() as ChildProcess;
  const execution = executeCommand("exit 7", {
    env: {},
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
    env: {},
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
