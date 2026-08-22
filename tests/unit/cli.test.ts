import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CliParseError, parseCliArgs } from "../../src/cli.js";
import { run } from "../../src/index.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../src/index.js", import.meta.url));

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

  const localUrl = await listenOnLoopback(server);

  try {
    const {
      value: result,
      logs,
      errors,
    } = await captureConsoleOutput(() =>
      run([
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
      ]),
    );

    assert.equal(result.exitCode, 2);
    assert.deepEqual(logs, []);
    assert.equal(logs.join("\n").includes("ls"), false);
    assert.match(errors.join("\n"), /must use git/);
  } finally {
    await closeServer(server);
  }
});

test("--print hides upstream provider error details from terminal output", async () => {
  const basicAuthPassword = "BASIC_AUTH_PASSWORD_SENTINEL";
  const queryToken = "QUERY_TOKEN_SENTINEL";
  const upstreamBody = "UPSTREAM_BODY_SENTINEL";
  const upstreamHeader = "UPSTREAM_HEADER_SENTINEL";
  const upstreamMessage = `${upstreamBody}: https://user:${basicAuthPassword}@provider.example/v1?token=${queryToken}`;
  let secretResponseDelivered = false;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }

    secretResponseDelivered = true;
    response.writeHead(401, {
      "content-type": "application/json",
      "x-upstream-secret": upstreamHeader,
    });
    response.end(
      JSON.stringify({
        error: {
          message: upstreamMessage,
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      }),
    );
  });

  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-provider-error-test-"));
  const localUrl = await listenOnLoopback(server);

  try {
    const result = await runCliProcess(
      [
        "--print",
        "--ai-provider",
        "openai",
        "--openai-api-url",
        localUrl,
        "--openai-model",
        "fake-model",
        "show repo status",
      ],
      {
        HOME: homeDirectory,
        HOWTO_OPENAI_API_KEY: "",
        OPENAI_LOG: "debug",
        PATH: process.env.PATH,
      },
    );

    const terminalOutput = Buffer.concat([result.stdout, result.stderr]).toString("utf8");
    assert.equal(secretResponseDelivered, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(
      result.stderr,
      Buffer.from("AI provider request failed (provider: openai, model: fake-model)\n"),
    );
    assert.equal(terminalOutput.includes(upstreamMessage), false);
    assert.equal(terminalOutput.includes(basicAuthPassword), false);
    assert.equal(terminalOutput.includes(queryToken), false);
    assert.equal(terminalOutput.includes(upstreamBody), false);
    assert.equal(terminalOutput.includes(upstreamHeader), false);
  } finally {
    await closeServer(server);
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  assert.ok(isAddressInfo(address));
  return `http://127.0.0.1:${address.port}`;
}

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

async function runCliProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(process.execPath, [CLI_ENTRYPOINT, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(Buffer.from(chunk));
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === null) {
        reject(new Error("CLI process exited without an exit code"));
        return;
      }

      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
  });
}

async function closeServer(server: Server): Promise<void> {
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

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return typeof address === "object" && address !== null;
}
