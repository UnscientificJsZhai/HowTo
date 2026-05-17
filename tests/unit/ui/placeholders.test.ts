import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import type { CommandCandidateContract } from "../../../src/ai/types";
import type { InteractiveInput, InteractiveOutput } from "../../../src/ui/interactive";
import {
  PlaceholderResolutionError,
  assertNoUnresolvedPlaceholders,
  promptPlaceholderValues,
  replaceCommandPlaceholders,
} from "../../../src/ui/placeholders";

class FakeInput extends PassThrough {
  isTTY = true;
}

class FakeOutput extends Writable {
  isTTY = true;
  chunks: string[] = [];

  _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(String(chunk));
    callback();
  }
}

const candidate: CommandCandidateContract = {
  title: "Find file",
  command: "find {{root}} -name \"{{name}}\" -print -exec echo {{name}} \\;",
  description: "Find a file and echo its name",
  placeholders: [
    {
      name: "root",
      description: "Search root",
    },
    {
      name: "name",
      description: "File name",
    },
  ],
};

test("replaceCommandPlaceholders replaces every occurrence without rewriting values", () => {
  const values = new Map([
    ["root", "  ./src  "],
    ["name", "package*.json"],
  ]);

  assert.equal(
    replaceCommandPlaceholders(candidate.command, values),
    "find   ./src   -name \"package*.json\" -print -exec echo package*.json \\;",
  );
});

test("promptPlaceholderValues asks placeholders in declaration order and preserves input", async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const prompt = promptPlaceholderValues(candidate.placeholders, {
    input: input as InteractiveInput,
    output: output as InteractiveOutput,
  });

  setImmediate(() => {
    input.write("  ./src  \n");
    input.write("package*.json\n");
  });

  const values = await prompt;

  assert.deepEqual([...values.entries()], [
    ["root", "  ./src  "],
    ["name", "package*.json"],
  ]);
  assert.match(output.chunks.join(""), /root: Search root[\s\S]*name: File name/);
});

test("assertNoUnresolvedPlaceholders rejects remaining placeholder syntax", () => {
  assert.throws(
    () => assertNoUnresolvedPlaceholders("find . -name {{filename}}"),
    PlaceholderResolutionError,
  );
});
