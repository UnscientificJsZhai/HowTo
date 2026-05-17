import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  InteractionCancelledError,
  type InteractiveInput,
  type InteractiveOutput,
} from "../../../src/ui/interactive";
import {
  confirmDangerousCommand,
  confirmFinalCommand,
  formatDangerousCommandConfirmation,
  formatFinalCommandConfirmation,
} from "../../../src/ui/confirm";

class FakeInput extends PassThrough {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }
}

class FakeOutput extends Writable {
  isTTY = true;
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }
}

test("formatFinalCommandConfirmation renders the final command and key instructions", () => {
  const text = formatFinalCommandConfirmation("echo hello");

  assert.match(text, /Final command:/);
  assert.match(text, /echo hello/);
  assert.match(text, /Press Enter to execute/);
});

test("confirmFinalCommand resolves on Enter", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const confirmation = confirmFinalCommand("echo hello", {
    input: input as InteractiveInput,
    output: output as InteractiveOutput,
  });

  input.emit("keypress", "", { name: "return" });

  await confirmation;
  assert.equal(input.isRaw, false);
  assert.match(output.chunks.join(""), /echo hello/);
});

test("confirmFinalCommand cancels on Escape", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const confirmation = confirmFinalCommand("echo hello", {
    input: input as InteractiveInput,
    output: output as InteractiveOutput,
  });

  input.emit("keypress", "", { name: "escape" });

  await assert.rejects(confirmation, InteractionCancelledError);
  assert.equal(input.isRaw, false);
});

test("confirmFinalCommand cancels on Ctrl+C", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const confirmation = confirmFinalCommand("echo hello", {
    input: input as InteractiveInput,
    output: output as InteractiveOutput,
  });

  input.emit("keypress", "", { name: "c", ctrl: true });

  await assert.rejects(confirmation, InteractionCancelledError);
});

test("formatDangerousCommandConfirmation renders risk and exact phrase instruction", () => {
  const text = formatDangerousCommandConfirmation("rm -rf /", {
    rule: "destructive-rm",
    reason: "recursive rm",
  });

  assert.match(text, /Dangerous command detected/);
  assert.match(text, /rm -rf \//);
  assert.match(text, /EXECUTE/);
});

test("confirmDangerousCommand resolves only on exact EXECUTE", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const confirmation = confirmDangerousCommand(
    "rm -rf /",
    { rule: "destructive-rm", reason: "recursive rm" },
    {
      input: input as InteractiveInput,
      output: output as InteractiveOutput,
    },
  );

  setImmediate(() => {
    input.write("EXECUTE\n");
  });

  await confirmation;
  assert.match(output.chunks.join(""), /Dangerous command detected/);
});

test("confirmDangerousCommand cancels when phrase does not match", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const confirmation = confirmDangerousCommand(
    "rm -rf /",
    { rule: "destructive-rm", reason: "recursive rm" },
    {
      input: input as InteractiveInput,
      output: output as InteractiveOutput,
    },
  );

  setImmediate(() => {
    input.write("execute\n");
  });

  await assert.rejects(confirmation, InteractionCancelledError);
});
