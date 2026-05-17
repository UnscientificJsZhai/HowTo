import assert from "node:assert/strict";
import test from "node:test";

import { CliParseError, parseCliArgs } from "../../src/cli";

test("parseCliArgs parses use mode with global options before positionals", () => {
  assert.deepEqual(
    parseCliArgs(["--ai-provider", "gemini", "use", "git", "列出最近提交"]),
    {
      options: {
        print: false,
        aiProvider: "gemini",
      },
      useCommand: "git",
      question: "列出最近提交",
      arguments: [],
    },
  );
});

test("parseCliArgs parses global options after positionals", () => {
  assert.deepEqual(parseCliArgs(["use", "git", "列出最近提交", "--print"]), {
    options: {
      print: true,
    },
    useCommand: "git",
    question: "列出最近提交",
    arguments: [],
  });
});

test("parseCliArgs keeps tokens after option terminator as arguments", () => {
  assert.deepEqual(parseCliArgs(["解释这个参数", "--", "--force"]), {
    options: {
      print: false,
    },
    question: "解释这个参数",
    arguments: ["--force"],
  });
});

test("parseCliArgs rejects incomplete use mode", () => {
  assert.throws(() => parseCliArgs(["use", "git"]), CliParseError);
});

test("parseCliArgs rejects missing option value", () => {
  assert.throws(() => parseCliArgs(["--ai-provider"]), CliParseError);
});
