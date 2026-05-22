import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import { executeCommand, resolveProcessExitCode } from "../../src/execute.js";

test("executeCommand uses POSIX shell exec semantics with inherited stdio", async () => {
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
  assert.deepEqual(receivedArgs, ["-lc", "exec echo hello"]);
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
  assert.deepEqual(receivedArgs, ["-lc", "exec echo hello"]);
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
