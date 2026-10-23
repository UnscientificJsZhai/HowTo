import assert from "node:assert/strict";
import test from "node:test";
import type OpenAI from "openai";
import type { GoogleGenAI } from "@google/genai";

import { COMMAND_GENERATION_SCHEMA } from "../../src/ai/command-schema.js";
import { buildGeminiGenerateContentRequest, GeminiCommandProvider } from "../../src/ai/gemini.js";
import {
  buildOpenAiChatCompletionRequest,
  buildOpenAiClientOptions,
  OpenAiCommandProvider,
} from "../../src/ai/openai.js";
import type { GenerateCommandsRequest } from "../../src/ai/types.js";

function createRequest(structuredOutput: boolean): GenerateCommandsRequest {
  return {
    question: "list files",
    arguments: [],
    structuredOutput,
    outputContract: "contract",
    safetyConstraints: "safety",
    systemPrompt: "system prompt",
    userPrompt: "user prompt",
  };
}

test("buildOpenAiChatCompletionRequest 在结构化模式使用 strict json schema，兼容模式保持 json_object", () => {
  const structured = buildOpenAiChatCompletionRequest("gpt-test", createRequest(true));
  assert.equal(structured.model, "gpt-test");
  assert.deepEqual(structured.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "user prompt" },
  ]);
  assert.deepEqual(structured.response_format, {
    type: "json_schema",
    json_schema: {
      name: "command_generation",
      description: "Shell command candidates generated for howto.",
      schema: COMMAND_GENERATION_SCHEMA,
      strict: true,
    },
  });

  const compatibility = buildOpenAiChatCompletionRequest("gpt-test", createRequest(false));
  assert.deepEqual(compatibility.response_format, { type: "json_object" });
});

test("OpenAI client options omit authorization when API key is empty", () => {
  const options = buildOpenAiClientOptions({
    apiKey: "",
    baseUrl: "http://localhost:11434/v1",
    model: "local-model",
  });

  assert.equal(options.apiKey, "howto-empty-api-key");
  assert.equal(options.baseURL, "http://localhost:11434/v1");
  assert.equal(options.logLevel, "off");
  assert.deepEqual(options.defaultHeaders, { Authorization: null });
});

test("OpenAI client options preserve non-empty API key", () => {
  const options = buildOpenAiClientOptions({
    apiKey: "openai-key",
    model: "gpt-test",
  });

  assert.equal(options.apiKey, "openai-key");
  assert.equal(options.baseURL, "https://api.openai.com/v1");
  assert.equal(options.logLevel, "off");
  assert.deepEqual(options.defaultHeaders, { Authorization: "Bearer openai-key" });
});

test("OpenAI 仅在有取消信号时传递 Signal 并关闭 SDK 自动重试", async () => {
  const calls: unknown[][] = [];
  const fakeClient = {
    chat: {
      completions: {
        create: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve({ choices: [{ message: { content: "generated" } }] });
        },
      },
    },
  } as unknown as OpenAI;
  const provider = new OpenAiCommandProvider(
    {
      apiKey: "openai-key",
      model: "gpt-test",
    },
    { client: fakeClient },
  );
  const controller = new AbortController();

  await provider.generateCommands(createRequest(true), controller.signal);
  await provider.generateCommands(createRequest(true));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 2);
  assert.deepEqual(calls[0][1], { signal: controller.signal, maxRetries: 0 });
  assert.equal(calls[1].length, 1);
});

test("buildGeminiGenerateContentRequest 在结构化模式使用 response schema，兼容模式保持无 schema 的 JSON", () => {
  const structured = buildGeminiGenerateContentRequest("gemini-test", createRequest(true));
  assert.equal(structured.model, "gemini-test");
  assert.equal(structured.contents, "user prompt");
  assert.deepEqual(structured.config, {
    systemInstruction: "system prompt",
    responseMimeType: "application/json",
    responseJsonSchema: COMMAND_GENERATION_SCHEMA,
  });

  const compatibility = buildGeminiGenerateContentRequest("gemini-test", createRequest(false));
  assert.deepEqual(compatibility.config, {
    systemInstruction: "system prompt",
    responseMimeType: "application/json",
  });
});

test("Gemini provider maps the supplied signal to config.abortSignal only when present", async () => {
  const requests: unknown[] = [];
  const fakeClient = {
    models: {
      generateContent: (request: unknown) => {
        requests.push(request);
        return Promise.resolve({ candidates: [{ content: { parts: [{ text: "generated" }] } }] });
      },
    },
  } as unknown as GoogleGenAI;
  const provider = new GeminiCommandProvider(
    {
      apiKey: "gemini-key",
      model: "gemini-test",
    },
    { client: fakeClient },
  );
  const controller = new AbortController();

  await provider.generateCommands(createRequest(true), controller.signal);
  await provider.generateCommands(createRequest(true));

  assert.equal(requests.length, 2);
  assert.equal(
    (requests[0] as ReturnType<typeof buildGeminiGenerateContentRequest>).config?.abortSignal,
    controller.signal,
  );
  assert.equal(
    "abortSignal" in
      ((requests[1] as ReturnType<typeof buildGeminiGenerateContentRequest>).config ?? {}),
    false,
  );
});
