import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import type { CommandCandidateContract } from "../../../src/ai/types";
import {
  InteractionCancelledError,
  InteractiveTtyError,
  type InteractiveInput,
  type InteractiveOutput,
  ensureInteractiveTty,
  formatCandidateSelection,
  selectCommandCandidate,
} from "../../../src/ui/interactive";

const candidates: CommandCandidateContract[] = [
  {
    title: "List files",
    command: "ls -la",
    description: "Show all files in long format",
    placeholders: [],
  },
  {
    title: "Show git status",
    command: "git status",
    description: "Show repository status",
    placeholders: [],
  },
];

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

test("formatCandidateSelection renders titles, commands, descriptions, and selected marker", () => {
  const text = formatCandidateSelection(candidates, 1);

  assert.equal(text.includes("  List files"), true);
  assert.match(text, /ls -la/);
  assert.match(text, /> Show git status/);
  assert.match(text, /Show repository status/);
});

test("ensureInteractiveTty rejects non-TTY streams", () => {
  const input = new FakeInput();
  input.isTTY = false;

  assert.throws(() => ensureInteractiveTty(input, new FakeOutput()), InteractiveTtyError);
});

test("selectCommandCandidate moves with arrow keys and selects with Enter", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectCommandCandidate(candidates, {
    input: input as InteractiveInput,
    output: output as InteractiveOutput,
  });

  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "return" });

  assert.equal(await selection, candidates[1]);
  assert.equal(input.isRaw, false);
});

test("selectCommandCandidate cancels on Escape", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectCommandCandidate(candidates, {
    input: input as InteractiveInput,
    output: output as InteractiveOutput,
  });

  input.emit("keypress", "", { name: "escape" });

  await assert.rejects(selection, InteractionCancelledError);
  assert.equal(input.isRaw, false);
});

test("selectCommandCandidate cancels on Ctrl+C", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const selection = selectCommandCandidate(candidates, {
    input: input as InteractiveInput,
    output: output as InteractiveOutput,
  });

  input.emit("keypress", "", { name: "c", ctrl: true });

  await assert.rejects(selection, InteractionCancelledError);
});
