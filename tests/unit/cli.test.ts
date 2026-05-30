import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

test("--print use rejects AI candidates that do not clearly use requested command", async () => {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                commands: [
                  {
                    title: "List files",
                    command: "ls",
                    description: "List files",
                    placeholders: [],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(isAddressInfo(address));
  const localUrl = `http://127.0.0.1:${address.port}`;
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
    const result = await run([
      "--print",
      "--ai-provider",
      "openai",
      "--openai-api-url",
      localUrl,
      "--openai-model",
      "fake-model",
      "use",
      "git",
      "show repo status",
    ]);

    assert.equal(result.exitCode, 2);
    assert.deepEqual(logs, []);
    assert.equal(logs.join("\n").includes("ls"), false);
    assert.match(errors.join("\n"), /must use git/);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return typeof address === "object" && address !== null;
}
