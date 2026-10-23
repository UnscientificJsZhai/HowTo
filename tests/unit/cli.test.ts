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
  });
});

test("parseCliArgs parses global options after positionals", () => {
  assert.deepEqual(parseCliArgs(["use", "git", "列出最近提交", "--print"]), {
    options: {
      print: true,
    },
    useCommand: "git",
    question: "列出最近提交",
  });
});

test("parseCliArgs keeps tokens after option terminator in the question", () => {
  assert.deepEqual(parseCliArgs(["解释这个参数", "--", "--force"]), {
    options: {
      print: false,
    },
    question: "解释这个参数 --force",
  });
});

for (const { input, question } of [
  { input: ["list", "files", "changed", "today"], question: "list files changed today" },
  { input: ["list files", "/tmp"], question: "list files /tmp" },
  { input: ["find", "files", "/tmp/my files"], question: "find files /tmp/my files" },
  { input: ["  list\t files\n", "\runder  /tmp  "], question: "  list\t files\n \runder  /tmp  " },
  { input: ["", "list", "", "files", ""], question: " list  files " },
  { input: ["show", "'quoted'", '"text"', "a\\b"], question: "show 'quoted' \"text\" a\\b" },
  {
    input: ["explain", "--", "--force", "--print", "--", "-n"],
    question: "explain --force --print -- -n",
  },
]) {
  for (const useMode of [false, true]) {
    test(`parseCliArgs joins ${useMode ? "use" : "ordinary"} question fragments: ${JSON.stringify(input)}`, () => {
      assert.deepEqual(parseCliArgs(useMode ? ["use", "find", ...input] : input), {
        options: { print: false },
        ...(useMode ? { useCommand: "find" } : {}),
        question,
      });
    });
  }
}

test("parseCliArgs excludes interspersed options and values from the complete question", () => {
  assert.deepEqual(
    parseCliArgs([
      "list",
      "--ai-provider",
      "gemini",
      "files",
      "--print",
      "changed",
      "--structured-output=false",
      "today",
    ]),
    {
      options: { print: true, aiProvider: "gemini", structuredOutput: "false" },
      question: "list files changed today",
    },
  );
  assert.deepEqual(
    parseCliArgs([
      "--print",
      "use",
      "--ai-provider=gemini",
      "find",
      "find",
      "--gemini-model",
      "model",
      "report.txt",
      "under",
      "/tmp",
    ]),
    {
      options: { print: true, aiProvider: "gemini", geminiModel: "model" },
      useCommand: "find",
      question: "find report.txt under /tmp",
    },
  );
});

test("parseCliArgs treats only the first positional use as the mode selector", () => {
  assert.equal(parseCliArgs(["explain", "use", "find"]).question, "explain use find");
  assert.deepEqual(parseCliArgs(["--", "use", "find", "list", "files"]), {
    options: { print: false },
    useCommand: "find",
    question: "list files",
  });
});

test("parseCliArgs rejects missing or whitespace-only questions in both modes", () => {
  for (const args of [
    [],
    ["--print"],
    ["use"],
    ["use", "find"],
    [""],
    ["", "   "],
    ["\t\r\n", "\u00a0"],
    ["use", "find", ""],
    ["use", "find", " ", "\n\t"],
    ["--print", "", "--", " "],
  ]) {
    assert.throws(() => parseCliArgs(args), CliParseError, JSON.stringify(args));
  }
});

test("parseCliArgs preserves unknown-option errors and repeated-option behavior", () => {
  for (const args of [
    ["list", "files", "--unknown"],
    ["use", "find", "files", "--unknown=value"],
    ["--help"],
  ]) {
    assert.throws(() => parseCliArgs(args), /unknown option/);
  }
  assert.deepEqual(
    parseCliArgs([
      "--print",
      "list",
      "--ai-provider=gemini",
      "files",
      "--ai-provider",
      "openai",
      "--print",
    ]),
    {
      options: { print: true, aiProvider: "openai" },
      question: "list files",
    },
  );
  assert.deepEqual(parseCliArgs(["--init", "--init"]), {
    options: { print: false, init: true },
  });
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
  });

  assert.deepEqual(parseCliArgs(["--structured-output=false", "question"]), {
    options: {
      print: false,
      structuredOutput: "false",
    },
    question: "question",
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
  });
});

test("parseCliArgs rejects init with print or question", () => {
  assert.throws(() => parseCliArgs(["--init", "--print"]), CliParseError);
  assert.throws(() => parseCliArgs(["--init", "question"]), CliParseError);
  assert.throws(() => parseCliArgs(["--init", "", " "]), CliParseError);
  assert.throws(() => parseCliArgs(["use", "find", "list", "files", "--init"]), CliParseError);
});

test("parseCliArgs 解析独立的 --version，无需 question", () => {
  assert.deepEqual(parseCliArgs(["--version"]), {
    options: { print: false, version: true },
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
    ["--version", "", " "],
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
  });
  assert.deepEqual(parseCliArgs(["解释这个参数", "--", "--version"]), {
    options: { print: false },
    question: "解释这个参数 --version",
  });
});

test("ChatGPT 独立动作无需问题，并支持显式账号", () => {
  for (const action of ["login", "logout", "status", "models"] as const) {
    assert.deepEqual(parseCliArgs([`--chatgpt-${action}`]), {
      options: { print: false, chatgptAction: action },
    });
    assert.deepEqual(parseCliArgs(["--chatgpt-account=work", `--chatgpt-${action}`]), {
      options: { print: false, chatgptAction: action, chatgptAccount: "work" },
    });
  }
});

test("ChatGPT 独立动作拒绝互斥动作、问题及生成参数", () => {
  const invalidArguments = [
    ["--chatgpt-login", "--chatgpt-logout"],
    ["--chatgpt-status", "--chatgpt-status"],
    ["--chatgpt-login=true"],
    ["--chatgpt-models="],
    ["--chatgpt-login", "--print"],
    ["--chatgpt-login", "--init"],
    ["--chatgpt-login", "--version"],
    ["--chatgpt-login", "--ai-provider=chatgpt"],
    ["--chatgpt-models", "--chatgpt-model=model"],
    ["--chatgpt-status", "question"],
    ["--chatgpt-status", "", " "],
    ["--chatgpt-status", "use", "git", "question"],
    ["--chatgpt-logout", "--", "question"],
  ];
  for (const args of invalidArguments) assert.throws(() => parseCliArgs(args), CliParseError);
});

test("ChatGPT 生成参数保留选项终止符与自然语言问题语义", () => {
  assert.deepEqual(
    parseCliArgs([
      "--ai-provider=chatgpt",
      "--chatgpt-account",
      "work",
      "--chatgpt-model=available-model",
      "--print",
      "login",
      "--",
      "--chatgpt-login",
    ]),
    {
      options: {
        print: true,
        aiProvider: "chatgpt",
        chatgptAccount: "work",
        chatgptModel: "available-model",
      },
      question: "login --chatgpt-login",
    },
  );
  assert.equal(parseCliArgs(["--", "--chatgpt-login"]).question, "--chatgpt-login");
  for (const option of ["--chatgpt-account", "--chatgpt-model"]) {
    assert.throws(() => parseCliArgs([option]), CliParseError);
    assert.throws(() => parseCliArgs([option, "--print", "question"]), CliParseError);
  }
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
