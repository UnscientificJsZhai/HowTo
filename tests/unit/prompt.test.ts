import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OUTPUT_CONTRACT,
  STRUCTURED_OUTPUT_CONTRACT,
  buildCommandGenerationPrompt,
  createProviderPromptRequest,
} from "../../src/prompt.js";
import type { ProviderPromptRequest } from "../../src/ai/types.js";

describe("buildCommandGenerationPrompt", () => {
  const baseRequest: ProviderPromptRequest = {
    question: "how to list files",
    arguments: [],
    useCommand: undefined,
    structuredOutput: false,
    outputContract: "CONTRACT",
    safetyConstraints: "SAFETY",
  };

  it("should separate system and user prompts and not include empty fields", () => {
    const { systemPrompt, userPrompt } = buildCommandGenerationPrompt(baseRequest);

    // System prompt should have core constraints
    assert.ok(systemPrompt.includes("CONTRACT"));
    assert.ok(systemPrompt.includes("SAFETY"));

    // User prompt should have the question
    assert.ok(userPrompt.includes('question: "how to list files"'));

    // Should not include optional fields
    assert.strictEqual(userPrompt.includes("useCommand:"), false);
    assert.strictEqual(userPrompt.includes("argument:"), false);
  });

  it("should include arguments in userPrompt when provided", () => {
    const request = { ...baseRequest, arguments: ["-la"] };
    const { userPrompt } = buildCommandGenerationPrompt(request);
    assert.ok(userPrompt.includes('argument: ["-la"]'));
  });

  it("should include useCommand in userPrompt when provided", () => {
    const request = { ...baseRequest, useCommand: "ls" };
    const { userPrompt } = buildCommandGenerationPrompt(request);
    assert.ok(userPrompt.includes('useCommand: "ls"'));
    assert.ok(userPrompt.includes('The user specified use <command>: "ls"'));
  });

  it("should use a short prompt contract when structured output is enabled", () => {
    const request = createProviderPromptRequest({
      question: "how to list files",
      arguments: [],
      structuredOutput: true,
    });

    assert.equal(request.outputContract, STRUCTURED_OUTPUT_CONTRACT);
  });

  it("should use the full prompt contract when structured output is disabled", () => {
    const request = createProviderPromptRequest({
      question: "how to list files",
      arguments: [],
      structuredOutput: false,
    });

    assert.equal(request.outputContract, OUTPUT_CONTRACT);
  });
});
