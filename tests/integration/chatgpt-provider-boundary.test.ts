import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CHILD = fileURLToPath(
  new URL("./fixtures/chatgpt-provider-boundary-child.js", import.meta.url),
);
const BASE_ENV = {
  OPENAI_BASE_URL: "https://HOWTO_FAKE_ENV_SECRET.invalid/v1",
  OPENAI_API_KEY: "HOWTO_FAKE_ENV_SECRET",
  OPENAI_ADMIN_KEY: "HOWTO_FAKE_ENV_SECRET",
  OPENAI_ORG_ID: "HOWTO_FAKE_ENV_SECRET",
  OPENAI_PROJECT_ID: "HOWTO_FAKE_ENV_SECRET",
  OPENAI_LOG: "debug",
};

for (const customHeaders of [
  "Authorization: Bearer HOWTO_FAKE_ENV_SECRET\nX-Token: HOWTO_FAKE_ENV_SECRET",
  "api-key: HOWTO_FAKE_ENV_SECRET\rTAIL",
]) {
  test("ChatGPT 隔离所有 SDK 环境变量及普通或非法自定义头", () => {
    const child = spawnSync(process.execPath, [CHILD], {
      env: { ...BASE_ENV, OPENAI_CUSTOM_HEADERS: customHeaders },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    assert.equal(child.stdout, expectedOutput(0));
    assert.doesNotMatch(child.stdout + child.stderr, /HOWTO_FAKE|Authorization|TypeError/);
    assert.equal((child.stdout + child.stderr).includes("\u001b"), false);
  });
}

for (const [mode, exitCode] of [
  ["unknown-thread", 0],
  ["subscription-shape", 0],
  ["http-401", 2],
  ["http-403", 1],
  ["http-429", 1],
  ["http-503", 1],
  ["stream-failed", 1],
  ["malformed", 1],
  ["incomplete", 1],
  ["invalid-json", 2],
  ["auth-error", 1],
] as const) {
  test(`ChatGPT 子进程 ${mode} 不回显凭证、上游正文或部分命令`, () => {
    const child = spawnSync(process.execPath, [CHILD], {
      env: { ...BASE_ENV, HOWTO_TEST_CHATGPT_MODE: mode },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, exitCode);
    assert.equal(child.stdout, expectedOutput(exitCode, mode === "auth-error"));
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /HOWTO_FAKE|private|Authorization|SyntaxError|TypeError/,
    );
    assert.equal((child.stdout + child.stderr).includes("\u001b"), false);
    if (mode === "stream-failed" || mode === "http-429") {
      assert.match(child.stderr, /usage limit reached/);
    } else if (["malformed", "incomplete", "auth-error"].includes(mode)) {
      assert.equal(
        child.stderr,
        "AI provider request failed (provider: chatgpt, model: chatgpt-test)\n",
      );
    } else if (mode === "invalid-json") {
      assert.equal(child.stderr, "AI response format error: AI response is not valid JSON\n");
    } else if (exitCode === 0) {
      assert.equal(child.stderr, "");
    }
  });
}

function expectedOutput(exitCode: number, noRequests = false): string {
  const requests = noRequests
    ? []
    : [
        {
          url: "https://api.openai.com/v1/responses",
          method: "POST",
          credentialsMatch: true,
          headersIsolated: true,
        },
      ];
  return `${exitCode === 0 ? "ls\n" : ""}${JSON.stringify({ requests, exitCode })}\n`;
}
