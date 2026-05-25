import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_GENERATION_SCHEMA } from "../../src/ai/command-schema.js";
import { buildGeminiGenerateContentRequest } from "../../src/ai/gemini.js";
import { buildOpenAiChatCompletionRequest } from "../../src/ai/openai.js";
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

test("buildOpenAiChatCompletionRequest keeps json_object in compatibility mode", () => {
  const request = buildOpenAiChatCompletionRequest("gpt-test", createRequest(false));

  assert.deepEqual(request.response_format, { type: "json_object" });
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
