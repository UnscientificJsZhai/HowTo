import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { run } from "../../src/index.js";

const CLI_ENTRYPOINT = fileURLToPath(new URL("../../src/index.js", import.meta.url));

for (const corruptConfig of [false, true]) {
  test(`--version 在非 TTY、${corruptConfig ? "配置损坏" : "未初始化"}时从任意工作目录输出包版本`, async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "howto-version-test-"));
    const configDirectory = join(homeDirectory, ".howto");
    const configContent = "{invalid JSON";

    try {
      await writeFile(join(homeDirectory, "package.json"), '{"version":"99.0.0"}', "utf8");
      if (corruptConfig) {
        await mkdir(configDirectory);
        await writeFile(join(configDirectory, "config.json"), configContent, "utf8");
      }

      const metadata = JSON.parse(
        await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      const result = await runCliProcess(
        ["--version"],
        { HOME: homeDirectory, PATH: process.env.PATH },
        homeDirectory,
      );

      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.stdout, Buffer.from(`${metadata.version}\n`));
      assert.equal(result.stderr.length, 0);
      assert.deepEqual(
        (await readdir(homeDirectory)).sort(),
        corruptConfig ? [".howto", "package.json"] : ["package.json"],
      );
      if (corruptConfig) {
        assert.equal(await readFile(join(configDirectory, "config.json"), "utf8"), configContent);
      }
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
}

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
                    dangerous: false,
                    dangerReason: "",
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

test("--print 允许未支持的 shell，并在真实请求中发送环境信息而不泄露配置", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      requestBody += chunk;
    });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  commands: [
                    {
                      title: "显示文本",
                      command: "printf howto",
                      description: "显示文本",
                      dangerous: false,
                      dangerReason: "",
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
  });
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-runtime-context-test-"));

  try {
    const localUrl = await listenOnLoopback(server);
    const result = await runCliProcess(
      ["--print", "--ai-provider", "openai", "--openai-api-url", localUrl, "显示文本"],
      {
        HOME: homeDirectory,
        PATH: process.env.PATH,
        SHELL: "/bin/fish-SHELL_SECRET_SENTINEL",
        HOWTO_OPENAI_API_KEY: "ENV_SECRET_SENTINEL",
      },
    );

    assert.equal(result.exitCode, 0, result.stderr.toString("utf8"));
    assert.equal(result.stdout.toString("utf8"), "printf howto\n");
    assert.equal(result.stderr.length, 0);
    const payload = JSON.parse(requestBody) as { messages: { role: string; content: string }[] };
    const systemPrompt = payload.messages.find((message) => message.role === "system")?.content;
    assert.ok(systemPrompt);
    assert.match(systemPrompt, /Runtime environment/);
    assert.ok(
      systemPrompt.includes(
        `"operatingSystem":"${process.platform === "darwin" ? "macOS" : "Linux"}"`,
      ),
    );
    assert.ok(systemPrompt.includes('"executionShell":null'));
  } finally {
    await closeServer(server);
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("--print 校验 AI 风险字段，只输出通过校验的命令且不泄露原因", async () => {
  const candidate = {
    title: "测试输出",
    command: "printf HOWTO_AI_REVIEW_PRINT_ONLY",
    description: "仅测试输出契约",
    dangerous: true,
    dangerReason: "PRIVATE_REASON_SENTINEL",
    placeholders: [],
  };
  let commands: unknown[] = [];
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify({ commands }) } }] }),
    );
  });
  const localUrl = await listenOnLoopback(server);

  try {
    // 校验合法候选：正常输出命令，且不泄露 dangerReason
    commands = [candidate];
    const valid = await captureConsoleOutput(() =>
      run([
        "--print",
        "--ai-provider",
        "openai",
        "--openai-api-url",
        localUrl,
        "--openai-api-key",
        "FAKE-test-key",
        "--openai-model",
        "fake-model",
        "测试风险标记",
      ]),
    );
    assert.equal(valid.value.exitCode, 0);
    assert.deepEqual(valid.logs, [candidate.command]);
    assert.deepEqual(valid.errors, []);
    assert.equal(
      [...valid.logs, ...valid.errors].join("\n").includes(candidate.dangerReason),
      false,
    );

    // 校验不合法候选（缺少 dangerous 字段）：报错退出且不泄露私有原因
    commands = [{ ...candidate, dangerous: undefined }];
    const invalid = await captureConsoleOutput(() =>
      run([
        "--print",
        "--ai-provider",
        "openai",
        "--openai-api-url",
        localUrl,
        "--openai-api-key",
        "FAKE-test-key",
        "--openai-model",
        "fake-model",
        "测试风险标记",
      ]),
    );
    assert.equal(invalid.value.exitCode, 2);
    assert.deepEqual(invalid.logs, []);
    assert.match(invalid.errors.join("\n"), /dangerous must be a boolean/);
    assert.equal(
      [...invalid.logs, ...invalid.errors].join("\n").includes(candidate.dangerReason),
      false,
    );
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
  const maliciousModel = "model-left\r\nmodel-right\u001B[2J api_key: model-secret";
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
        maliciousModel,
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
      Buffer.from(
        "AI provider request failed (provider: openai, model: model-left\u240d\u240amodel-right\ufffd[2J api_key: [redacted])\n",
      ),
    );
    assert.equal(terminalOutput.includes(upstreamMessage), false);
    assert.equal(terminalOutput.includes(basicAuthPassword), false);
    assert.equal(terminalOutput.includes(queryToken), false);
    assert.equal(terminalOutput.includes(upstreamBody), false);
    assert.equal(terminalOutput.includes(upstreamHeader), false);
    assert.equal(terminalOutput.includes("model-secret"), false);
    assert.equal(result.stderr.includes(Buffer.from("\u001B[2J")), false);
  } finally {
    await closeServer(server);
    await rm(homeDirectory, { recursive: true, force: true });
  }
});

test("malicious invalid user config exits with only the fixed summary", async () => {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-malicious-config-path-sentinel-"));
  const configDirectory = join(homeDirectory, ".howto");
  const configSecret = "CONFIG_SECRET_SENTINEL";
  const attackSequence = "\u001B[2JCONFIG_ATTACK_SENTINEL";
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "config.json"),
    `{"openaiApiKey":"${configSecret}","broken":"${attackSequence}"`,
    "utf8",
  );

  try {
    const result = await runCliProcess(["--print", "show repo status"], {
      HOME: homeDirectory,
      PATH: process.env.PATH,
    });

    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout.length, 0);
    assert.deepEqual(
      result.stderr,
      Buffer.from("Configuration error: user config file is not valid JSON\n"),
    );
    assert.equal(result.stderr.includes(Buffer.from(configSecret)), false);
    assert.equal(result.stderr.includes(Buffer.from(homeDirectory)), false);
    assert.equal(result.stderr.includes(Buffer.from(attackSequence)), false);
    assert.equal(result.stderr.includes(Buffer.from("CONFIG_ATTACK_SENTINEL")), false);
  } finally {
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
  cwd?: string,
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  const child = spawn(process.execPath, [CLI_ENTRYPOINT, ...args], {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
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
