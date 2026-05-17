import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { ChildProcess } from "node:child_process";

import { executeCommand, resolveProcessExitCode } from "../../src/execute";

test("executeCommand runs the command through the configured shell with inherited stdio", async () => {
  const child = new EventEmitter() as ChildProcess;
  let receivedCommand: string | undefined;
  let receivedOptions:
    | {
        shell: string | boolean;
        stdio: "inherit";
      }
    | undefined;

  const execution = executeCommand("echo hello", {
    env: { SHELL: "/bin/zsh" },
    spawnCommand(command, options) {
      receivedCommand = command;
      receivedOptions = options;
      return child;
    },
  });

  child.emit("close", 0, null);

  assert.equal(await execution, 0);
  assert.equal(receivedCommand, "echo hello");
  assert.deepEqual(receivedOptions, {
    shell: "/bin/zsh",
    stdio: "inherit",
  });
});

test("executeCommand falls back to Node shell handling when SHELL is empty", async () => {
  const child = new EventEmitter() as ChildProcess;
  let receivedShell: string | boolean | undefined;

  const execution = executeCommand("echo hello", {
    env: {},
    spawnCommand(_command, options) {
      receivedShell = options.shell;
      return child;
    },
  });

  child.emit("close", 0, null);

  assert.equal(await execution, 0);
  assert.equal(receivedShell, true);
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
