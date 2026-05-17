import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, loadConfig } from "../../src/config";

test("loadConfig uses defaults for OpenAI provider", () => {
  assert.deepEqual(loadConfig({ print: false }, {}), {
    aiProvider: "openai",
    gemini: {
      apiKey: undefined,
      model: "gemini-3.1-flash-lite",
    },
    openai: {
      apiKey: "",
      model: "gpt-5.4-mini",
      baseUrl: undefined,
    },
  });
});

test("loadConfig lets CLI options override environment values", () => {
  assert.deepEqual(
    loadConfig(
      {
        print: false,
        aiProvider: "gemini",
        geminiApiKey: "cli-gemini-key",
        geminiModel: "cli-gemini-model",
      },
      {
        HOWTO_AI_PROVIDER: "openai",
        HOWTO_GEMINI_API_KEY: "env-gemini-key",
        HOWTO_GEMINI_MODEL: "env-gemini-model",
      },
    ),
    {
      aiProvider: "gemini",
      gemini: {
        apiKey: "cli-gemini-key",
        model: "cli-gemini-model",
      },
      openai: {
        apiKey: "",
        model: "gpt-5.4-mini",
        baseUrl: undefined,
      },
    },
  );
});

test("loadConfig rejects invalid provider", () => {
  assert.throws(
    () => loadConfig({ print: false, aiProvider: "anthropic" }, {}),
    ConfigError,
  );
});

test("loadConfig requires Gemini API key when Gemini is selected", () => {
  assert.throws(() => loadConfig({ print: false, aiProvider: "gemini" }, {}), ConfigError);
});
