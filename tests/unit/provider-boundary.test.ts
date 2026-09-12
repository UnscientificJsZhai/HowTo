import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
    env: { ...GEMINI_SDK_URLS, GOOGLE_GENAI_USE_VERTEXAI: "true" },
    url: GEMINI_URL,
  },
  {
    name: "Gemini 忽略 Enterprise 模式环境开关",
    provider: "gemini",
    env: { ...GEMINI_SDK_URLS, GOOGLE_GENAI_USE_ENTERPRISE: "true" },
    url: GEMINI_URL,
  },
  {
    name: "Gemini 忽略同时开启的 cloud 模式及隐式项目配置",
    provider: "gemini",
    env: {
      ...GEMINI_SDK_URLS,
      GOOGLE_GENAI_USE_ENTERPRISE: "true",
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_CLOUD_PROJECT: "howto-fake-project",
      GOOGLE_CLOUD_LOCATION: "us-central1",
    },
    url: GEMINI_URL,
  },
  ...[
    { GOOGLE_GENAI_USE_ENTERPRISE: "true", GOOGLE_GENAI_USE_VERTEXAI: "false" },
    { GOOGLE_GENAI_USE_ENTERPRISE: "false", GOOGLE_GENAI_USE_VERTEXAI: "true" },
  ].map((flags): BoundaryCase => ({
    name: `Gemini 忽略冲突模式且不写警告（Enterprise=${flags.GOOGLE_GENAI_USE_ENTERPRISE}）`,
    provider: "gemini",
    env: { ...GEMINI_SDK_URLS, ...flags },
    url: GEMINI_URL,
  })),
];

for (const scenario of cases) {
  test(scenario.name, () => {
    // 子进程只接收这些假配置，不继承开发者的 key、HOME 或 SDK 配置。
    const child = spawnSync(process.execPath, [CHILD_ENTRYPOINT], {
      env: {
        HOWTO_AI_PROVIDER: scenario.provider,
        HOWTO_OPENAI_API_KEY: "howto-fake-openai-key",
        HOWTO_OPENAI_MODEL: "gpt-test",
        HOWTO_GEMINI_API_KEY: "howto-fake-gemini-key",
        HOWTO_GEMINI_MODEL: "gemini-test",
        ...scenario.env,
      },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    });

    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, "");
    assert.equal(
      child.stdout,
      `${JSON.stringify({
        requests: [{ url: scenario.url, method: "POST", credentialsMatch: true }],
        responseMatches: true,
      })}\n`,
    );
  });
}
