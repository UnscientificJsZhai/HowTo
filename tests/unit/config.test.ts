import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, hasExplicitAiProvider, loadConfig } from "../../src/config.js";

test("hasExplicitAiProvider detects missing provider", () => {
  assert.equal(hasExplicitAiProvider({ print: false }, {}), false);
});

test("hasExplicitAiProvider detects CLI provider", () => {
  assert.equal(hasExplicitAiProvider({ print: false, aiProvider: "openai" }, {}), true);
});

test("hasExplicitAiProvider detects environment provider", () => {
  assert.equal(hasExplicitAiProvider({ print: false }, { HOWTO_AI_PROVIDER: "gemini" }), true);
});

test("hasExplicitAiProvider detects config file provider", () => {
  assert.equal(hasExplicitAiProvider({ print: false }, {}, { aiProvider: "openai" }), true);
});

test("loadConfig requires an explicit provider", () => {
  assert.throws(() => loadConfig({ print: false }, {}), ConfigError);
});

test("loadConfig uses model defaults after provider is configured", () => {
  assert.deepEqual(loadConfig({ print: false, aiProvider: "openai" }, {}), {
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
    structuredOutput: true,
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
      structuredOutput: true,
    },
  );
});

test("loadConfig applies priority CLI over env over config file over defaults", () => {
  assert.deepEqual(
    loadConfig(
      {
        print: false,
        aiProvider: "openai",
        openaiModel: "cli-openai-model",
      },
      {
        HOWTO_AI_PROVIDER: "gemini",
        HOWTO_OPENAI_API_KEY: "env-openai-key",
      },
      {
        aiProvider: "gemini",
        openaiApiKey: "file-openai-key",
        openaiModel: "file-openai-model",
        openaiApiUrl: "https://file.example/v1",
      },
    ),
    {
      aiProvider: "openai",
      gemini: {
        apiKey: undefined,
        model: "gemini-3.1-flash-lite",
      },
      openai: {
        apiKey: "env-openai-key",
        model: "cli-openai-model",
        baseUrl: "https://file.example/v1",
      },
      structuredOutput: true,
    },
  );
});

test("loadConfig lets config file override defaults", () => {
  assert.deepEqual(
    loadConfig({ print: false }, {}, { aiProvider: "openai", openaiModel: "file-model" }),
    {
      aiProvider: "openai",
      gemini: {
        apiKey: undefined,
        model: "gemini-3.1-flash-lite",
      },
      openai: {
        apiKey: "",
        model: "file-model",
        baseUrl: undefined,
      },
      structuredOutput: true,
    },
  );
});

test("loadConfig rejects invalid provider", () => {
  assert.throws(() => loadConfig({ print: false, aiProvider: "anthropic" }, {}), ConfigError);
});

test("loadConfig requires Gemini API key when Gemini is selected", () => {
  assert.throws(() => loadConfig({ print: false, aiProvider: "gemini" }, {}), ConfigError);
});

test("loadConfig resolves structuredOutput with default and priority", () => {
  assert.equal(loadConfig({ print: false, aiProvider: "openai" }, {}).structuredOutput, true);

  assert.equal(
    loadConfig(
      { print: false, aiProvider: "openai", structuredOutput: "false" },
      { HOWTO_STRUCTURED_OUTPUT: "true" },
      { structuredOutput: true },
    ).structuredOutput,
    false,
  );

  assert.equal(
    loadConfig(
      { print: false, aiProvider: "openai" },
      { HOWTO_STRUCTURED_OUTPUT: "false" },
      { structuredOutput: true },
    ).structuredOutput,
    false,
  );

  assert.equal(
    loadConfig({ print: false, aiProvider: "openai" }, {}, { structuredOutput: "false" })
      .structuredOutput,
    false,
  );
});

test("loadConfig accepts boolean structuredOutput from config file", () => {
  assert.equal(
    loadConfig({ print: false, aiProvider: "openai" }, {}, { structuredOutput: false })
      .structuredOutput,
    false,
  );
});

test("loadConfig rejects invalid structuredOutput values", () => {
  assert.throws(
    () => loadConfig({ print: false, aiProvider: "openai", structuredOutput: "yes" }, {}),
    ConfigError,
  );
  assert.throws(
    () => loadConfig({ print: false, aiProvider: "openai" }, { HOWTO_STRUCTURED_OUTPUT: "yes" }),
    ConfigError,
  );
  assert.throws(
    () => loadConfig({ print: false, aiProvider: "openai" }, {}, { structuredOutput: "yes" }),
    ConfigError,
  );
});
