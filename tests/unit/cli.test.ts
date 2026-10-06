import assert from "node:assert/strict";
import test from "node:test";

import { CliParseError, parseCliArgs } from "../../src/cli.js";
import { run } from "../../src/index.js";

test("parseCliArgs parses use mode with global options before positionals", () => {
  assert.deepEqual(parseCliArgs(["--ai-provider", "gemini", "use", "git", "列出最近提交"]), {
    options: {
      print: false,
      aiProvider: "gemini",
    },
    useCommand: "git",
    question: "列出最近提交",
    arguments: [],
  });
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

test("parseCliArgs parses structured-output option", () => {
  assert.deepEqual(parseCliArgs(["--structured-output", "true", "question"]), {
    options: {
      print: false,
      structuredOutput: "true",
    },
    question: "question",
    arguments: [],
  });

  assert.deepEqual(parseCliArgs(["--structured-output=false", "question"]), {
    options: {
      print: false,
      structuredOutput: "false",
    },
    question: "question",
    arguments: [],
  });
});

test("parseCliArgs rejects missing structured-output value", () => {
  assert.throws(() => parseCliArgs(["--structured-output"]), CliParseError);
});

test("parseCliArgs parses init without question", () => {
  assert.deepEqual(parseCliArgs(["--init"]), {
    options: {
      print: false,
      init: true,
    },
    arguments: [],
  });
});

test("parseCliArgs rejects init with print or question", () => {
  assert.throws(() => parseCliArgs(["--init", "--print"]), CliParseError);
  assert.throws(() => parseCliArgs(["--init", "question"]), CliParseError);
});

test("parseCliArgs 解析独立的 --version，无需 question", () => {
  assert.deepEqual(parseCliArgs(["--version"]), {
    options: { print: false, version: true },
    arguments: [],
  });
});

test("parseCliArgs 拒绝 --version 附带值或与其他参数混用", () => {
  const invalidArguments = [
    ["--version=true"],
    ["--version="],
    ["--version", "1.0.0"],
    ["--version", "--init"],
    ["--init", "--version"],
    ["--version", "--print"],
    ["--version", "--ai-provider", "openai"],
    ["--openai-model=model", "--version"],
    ["--version", "question"],
    ["question", "--version"],
    ["--version", "use", "git", "question"],
    ["--version", "--version"],
    ["--version", "--"],
  ];

  for (const args of invalidArguments) {
    assert.throws(() => parseCliArgs(args), CliParseError, JSON.stringify(args));
  }
});

test("parseCliArgs 将 -- 后的 --version 保留为位置参数", () => {
  assert.deepEqual(parseCliArgs(["--", "--version"]), {
    options: { print: false },
    question: "--version",
    arguments: [],
  });
  assert.deepEqual(parseCliArgs(["解释这个参数", "--", "--version"]), {
    options: { print: false },
    question: "解释这个参数",
    arguments: ["--version"],
  });
});

test("--version 用法错误仅输出错误与 Usage，退出码为 2", async () => {
  for (const args of [["--version=true"], ["--version", "--init"], ["question", "--version"]]) {
    const { value, logs, errors } = await captureConsoleOutput(() => run(args));
    assert.equal(value.exitCode, 2);
    assert.deepEqual(logs, []);
    assert.match(errors.join("\n"), /--version (?:does not accept a value|must be used alone)/);
    assert.match(errors.join("\n"), /Usage: howto/);
    assert.match(errors.join("\n"), /howto --version/);
  }
});

async function captureConsoleOutput<T>(
  operation: () => Promise<T>,
): Promise<{ value: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...values: unknown[]) => {
    logs.push(values.join(" "));
  };
  console.error = (...values: unknown[]) => {
    errors.push(values.join(" "));
  };

  try {
    return { value: await operation(), logs, errors };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
