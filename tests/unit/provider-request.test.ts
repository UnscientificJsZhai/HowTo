import assert from "node:assert/strict";
import test from "node:test";

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

test("buildOpenAiChatCompletionRequest uses strict json schema in structured mode", () => {
  const request = buildOpenAiChatCompletionRequest("gpt-test", createRequest(true));

  assert.equal(request.model, "gpt-test");
  assert.deepEqual(request.messages, [
    { role: "system", content: "system prompt" },
    { role: "user", content: "user prompt" },
  ]);
  assert.deepEqual(request.response_format, {
    type: "json_schema",
    json_schema: {
      name: "command_generation",
      description: "Shell command candidates generated for howto.",
      schema: COMMAND_GENERATION_SCHEMA,
      strict: true,
    },
  });
});

test("command generation schema limits command candidates to one through three items", () => {
  assert.equal(COMMAND_GENERATION_SCHEMA.properties.commands.minItems, 1);
  assert.equal(COMMAND_GENERATION_SCHEMA.properties.commands.maxItems, 3);
});

test("buildOpenAiChatCompletionRequest keeps json_object in compatibility mode", () => {
  const request = buildOpenAiChatCompletionRequest("gpt-test", createRequest(false));

  assert.deepEqual(request.response_format, { type: "json_object" });
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
  assert.equal(options.baseURL, undefined);
  assert.equal(options.logLevel, "off");
  assert.equal(options.defaultHeaders, undefined);
});

test("OpenAI provider initializes when API key is empty", () => {
  assert.doesNotThrow(
    () =>
      new OpenAiCommandProvider({
        apiKey: "",
        baseUrl: "http://localhost:11434/v1",
        model: "local-model",
      }),
  );
});

test("OpenAI provider passes the supplied signal as SDK request options only when present", async () => {
  const provider = new OpenAiCommandProvider({
    apiKey: "openai-key",
    model: "gpt-test",
  });
  const calls: unknown[][] = [];
  Reflect.set(provider, "client", {
    chat: {
      completions: {
        create: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve({ choices: [{ message: { content: "generated" } }] });
        },
      },
    },
  });
  const controller = new AbortController();

  await provider.generateCommands(createRequest(true), controller.signal);
  await provider.generateCommands(createRequest(true));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].length, 2);
  assert.deepEqual(calls[0][1], { signal: controller.signal });
  assert.equal(calls[1].length, 1);
});

test("buildGeminiGenerateContentRequest uses response schema in structured mode", () => {
  const request = buildGeminiGenerateContentRequest("gemini-test", createRequest(true));

  assert.equal(request.model, "gemini-test");
  assert.equal(request.contents, "user prompt");
  assert.deepEqual(request.config, {
    systemInstruction: "system prompt",
    responseMimeType: "application/json",
    responseJsonSchema: COMMAND_GENERATION_SCHEMA,
  });
});

test("buildGeminiGenerateContentRequest keeps JSON mode without schema in compatibility mode", () => {
  const request = buildGeminiGenerateContentRequest("gemini-test", createRequest(false));

  assert.deepEqual(request.config, {
    systemInstruction: "system prompt",
    responseMimeType: "application/json",
  });
});

test("Gemini provider maps the supplied signal to config.abortSignal only when present", async () => {
  const provider = new GeminiCommandProvider({
    apiKey: "gemini-key",
    model: "gemini-test",
  });
  const requests: unknown[] = [];
  Reflect.set(provider, "client", {
    models: {
      generateContent: (request: unknown) => {
        requests.push(request);
        return Promise.resolve({ text: "generated" });
      },
    },
  });
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
