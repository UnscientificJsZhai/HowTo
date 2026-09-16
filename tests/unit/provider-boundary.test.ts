import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CHILD_ENTRYPOINT = fileURLToPath(
  new URL("./fixtures/provider-boundary-child.js", import.meta.url),
);
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent";
const OPENAI_SDK_ENV = {
  OPENAI_BASE_URL: "https://sdk-override.invalid/openai/v1",
  OPENAI_API_KEY: "howto-fake-sdk-openai-key",
  OPENAI_LOG: "debug",
};
const GEMINI_SDK_URLS = {
  GOOGLE_GEMINI_BASE_URL: "https://sdk-override.invalid/gemini/",
  GOOGLE_VERTEX_BASE_URL: "https://sdk-override.invalid/vertex/",
};

for (const [name, customHeaders, succeeds] of [
  ["非法 header 值", "api-key: HOWTO_FAKE_HEADER_SECRET\rTAIL", false],
  ["合法普通 header", "X-Token: HOWTO_FAKE_HEADER_SECRET", true],
] as const) {
  test(`OpenAI SDK 初始化的${name}不向 CLI 输出泄露凭据`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "howto-provider-init-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./fixtures/provider-initialization-child.js", import.meta.url))],
      {
        env: { HOME: home, PATH: "/usr/bin:/bin", OPENAI_CUSTOM_HEADERS: customHeaders },
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, succeeds ? 0 : 1);
    assert.equal(
      child.stdout,
      succeeds ? 'ls\n{"requests":1,"exitCode":0}\n' : '{"requests":0,"exitCode":1}\n',
    );
    assert.equal(
      child.stderr,
      succeeds ? "" : "AI provider request failed (provider: openai, model: gpt-test)\n",
    );
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /HOWTO_FAKE_HEADER_SECRET|howto-fake-config-key|TypeError|Headers\.append/,
    );
    assert.equal((child.stdout + child.stderr).includes("\u001b"), false);
  });
}

interface BoundaryCase {
  name: string;
  provider: "openai" | "gemini";
  env?: NodeJS.ProcessEnv;
  url: string;
}

const cases: BoundaryCase[] = [
  { name: "OpenAI 默认使用官方地址", provider: "openai", url: OPENAI_URL },
  {
    name: "OpenAI 忽略 SDK 隐式地址并保留 HOWTO 假 key",
    provider: "openai",
    env: OPENAI_SDK_ENV,
    url: OPENAI_URL,
  },
  {
    name: "OpenAI 空 key 不附带 Authorization 且忽略 SDK 隐式地址",
    provider: "openai",
    env: { ...OPENAI_SDK_ENV, HOWTO_OPENAI_API_KEY: "" },
    url: OPENAI_URL,
  },
  {
    name: "OpenAI 保留 HOWTO 显式自定义地址",
    provider: "openai",
    env: { ...OPENAI_SDK_ENV, HOWTO_OPENAI_API_URL: "https://howto-custom.invalid/v1" },
    url: "https://howto-custom.invalid/v1/chat/completions",
  },
  {
    name: "OpenAI 自定义地址保留空 key 的无认证行为",
    provider: "openai",
    env: {
      ...OPENAI_SDK_ENV,
      HOWTO_OPENAI_API_URL: "https://howto-custom.invalid/v1",
      HOWTO_OPENAI_API_KEY: "",
    },
    url: "https://howto-custom.invalid/v1/chat/completions",
  },
  {
    name: "OpenAI 显式空地址继续回退官方地址",
    provider: "openai",
    env: { ...OPENAI_SDK_ENV, HOWTO_OPENAI_API_URL: "" },
    url: OPENAI_URL,
  },
  {
    name: "OpenAI 官方地址显式 key 不受 SDK 隐式 Header 覆盖",
    provider: "openai",
    env: {
      ...OPENAI_SDK_ENV,
      HOWTO_OPENAI_API_KEY: "howto-fake-openai-key",
      OPENAI_CUSTOM_HEADERS: "Authorization: Bearer howto-fake-sdk-header-key",
    },
    url: OPENAI_URL,
  },
  { name: "Gemini 默认使用官方 v1beta 地址", provider: "gemini", url: GEMINI_URL },
  {
    name: "Gemini 忽略两个 SDK 隐式地址并保留 HOWTO 假 key",
    provider: "gemini",
    env: { ...GEMINI_SDK_URLS, GOOGLE_API_KEY: "howto-fake-sdk-google-key" },
    url: GEMINI_URL,
  },
  {
    name: "Gemini 忽略 Vertex 模式环境开关",
    provider: "gemini",
    env: {
      ...GEMINI_SDK_URLS,
      GOOGLE_API_KEY: "howto-fake-sdk-google-key",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
    },
    url: GEMINI_URL,
  },
];

for (const boundaryCase of cases) {
  test(`提供商地址与认证边界：${boundaryCase.name}`, () => {
    const child = spawnSync(process.execPath, [CHILD_ENTRYPOINT], {
      env: {
        HOWTO_AI_PROVIDER: boundaryCase.provider,
        HOWTO_OPENAI_API_KEY: "howto-fake-openai-key",
        HOWTO_OPENAI_MODEL: "gpt-test",
        HOWTO_GEMINI_API_KEY: "howto-fake-gemini-key",
        HOWTO_GEMINI_MODEL: "gemini-test",
        ...boundaryCase.env,
      },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0);
    assert.equal(child.stderr, "");
    assert.equal((child.stdout + child.stderr).includes("\u001b"), false);
    assert.doesNotMatch(child.stdout, /howto-fake-(?:sdk|secret)/);
    assert.equal(
      child.stdout,
      `${JSON.stringify({
        requests: [{ url: boundaryCase.url, method: "POST", credentialsMatch: true }],
        responseMatches: true,
      })}\n`,
    );
  });
}

for (const [mode, exitCode] of [
  ["valid", 0],
  ["blank", 1],
  ["invalid-json", 2],
] as const) {
  test(`OpenAI content ${mode} 保持固定错误类别且不回显上游内容`, () => {
    const child = spawnSync(process.execPath, [CHILD_ENTRYPOINT], {
      env: {
        HOWTO_AI_PROVIDER: "openai",
        HOWTO_OPENAI_API_KEY: "howto-fake-openai-key",
        HOWTO_OPENAI_MODEL: "gpt-test",
        HOWTO_TEST_OPENAI_ENVELOPE: mode,
      },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, exitCode);
    assert.equal((child.stdout + child.stderr).includes("\u001b"), false);
    assert.doesNotMatch(child.stdout + child.stderr, /HOWTO_FAKE_ENVELOPE_SECRET|TypeError|\.trim/);
    assert.equal(
      child.stdout,
      `${JSON.stringify({
        requests: [{ url: OPENAI_URL, method: "POST", credentialsMatch: true }],
        responseMatches: exitCode === 0,
      })}\n`,
    );
    assert.equal(
      child.stderr,
      exitCode === 0
        ? ""
        : exitCode === 1
          ? "AI provider request failed (provider: openai, model: gpt-test)\n"
          : "AI response format error: AI response is not valid JSON\n",
    );
  });
}

for (const [mode, exitCode] of [
  ["mixed", 0],
  ["throwing-getter", 0],
  ["bad-text", 1],
  ["invalid-json", 2],
] as const) {
  test(`Gemini envelope ${mode} 不泄漏 SDK getter 日志或原始字段`, () => {
    const child = spawnSync(process.execPath, [CHILD_ENTRYPOINT], {
      env: {
        HOWTO_AI_PROVIDER: "gemini",
        HOWTO_GEMINI_API_KEY: "howto-fake-gemini-key",
        HOWTO_GEMINI_MODEL: "gemini-test",
        HOWTO_TEST_GEMINI_ENVELOPE: mode,
      },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal((child.stdout + child.stderr).includes("\u001b"), false);
    assert.doesNotMatch(
      child.stdout + child.stderr,
      /envelope_probe|HOWTO_FAKE_ENVELOPE_SECRET|there are (?:multiple candidates|non-text parts)/,
    );
    assert.equal(child.status, exitCode);
    assert.equal(
      child.stdout,
      `${JSON.stringify({
        requests:
          mode === "throwing-getter"
            ? []
            : [{ url: GEMINI_URL, method: "POST", credentialsMatch: true }],
        responseMatches: exitCode === 0,
        getterReads: 0,
      })}\n`,
    );
    assert.equal(
      child.stderr,
      exitCode === 0
        ? ""
        : exitCode === 1
          ? "AI provider request failed (provider: gemini, model: gemini-test)\n"
          : "AI response format error: AI response is not valid JSON\n",
    );
  });
}
