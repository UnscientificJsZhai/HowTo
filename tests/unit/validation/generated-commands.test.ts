import assert from "node:assert/strict";
import test from "node:test";

import type { CommandProvider, GenerateCommandsRequest } from "../../../src/ai/types.js";
import { AiResponseValidationError } from "../../../src/validation/ai-response.js";
import { generateValidatedCommandCandidates } from "../../../src/validation/generated-commands.js";

test("generateValidatedCommandCandidates returns valid command candidates", async () => {
  const candidates = await generateValidatedCommandCandidates(
    createProviderWithRawText(
      JSON.stringify({
        commands: [validCommand("git status")],
      }),
    ),
    createRequest(),
  );

  assert.deepEqual(candidates, [validCommand("git status")]);
});

test("generateValidatedCommandCandidates passes the same optional signal to the provider", async () => {
  const request = createRequest();
  const controller = new AbortController();
  let capturedRequest: GenerateCommandsRequest | undefined;
  let capturedSignal: AbortSignal | undefined;
  const provider: CommandProvider = {
    generateCommands(providerRequest, signal) {
      capturedRequest = providerRequest;
      capturedSignal = signal;
      return Promise.resolve({
        rawText: JSON.stringify({ commands: [validCommand("git status")] }),
      });
    },
  };

  await generateValidatedCommandCandidates(provider, request, controller.signal);

  assert.equal(capturedRequest, request);
  assert.equal(capturedSignal, controller.signal);
});

test("generateValidatedCommandCandidates preserves AI response validation errors", async () => {
  await assert.rejects(
    () =>
      generateValidatedCommandCandidates(createProviderWithRawText("not-json"), createRequest()),
    AiResponseValidationError,
  );
});

test("generateValidatedCommandCandidates rejects candidates that do not use requested command", async () => {
  await assert.rejects(
    () =>
      generateValidatedCommandCandidates(
        createProviderWithRawText(
          JSON.stringify({
            commands: [validCommand("ls")],
          }),
        ),
        createRequest({ useCommand: "git" }),
      ),
    AiResponseValidationError,
  );
});

test("generateValidatedCommandCandidates accepts conservative git prefixes", async () => {
  const candidates = await generateValidatedCommandCandidates(
    createProviderWithRawText(
      JSON.stringify({
        commands: [
          validCommand("git status"),
          validCommand("sudo git status"),
          validCommand("FOO=bar git status"),
        ],
      }),
    ),
    createRequest({ useCommand: "git" }),
  );

  assert.deepEqual(
    candidates.map((candidate) => candidate.command),
    ["git status", "sudo git status", "FOO=bar git status"],
  );
});

test("use 校验保留已声明的普通参数占位符模板", async () => {
  const command = {
    ...validCommand("git log -n {{count}}"),
    placeholders: [{ name: "count", description: "Number of commits" }],
  };
  const result = await generateValidatedCommandCandidates(
    createProviderWithRawText(JSON.stringify({ commands: [command] })),
    createRequest({ useCommand: "git" }),
  );
  assert.deepEqual(result, [command]);
});

test("生成链路只给当前候选的已声明模板启用分析副本", async () => {
  const commands = [
    { ...validCommand("git '{{path}}'"), placeholders: [{ name: "path", description: "Path" }] },
    { ...validCommand("git \\{{path}}"), placeholders: [{ name: "path", description: "Path" }] },
    {
      ...validCommand("git show | head -n {{count}}"),
      placeholders: [{ name: "count", description: "Count" }],
    },
  ];
  const result = await generateValidatedCommandCandidates(
    createProviderWithRawText(JSON.stringify({ commands })),
    createRequest({ useCommand: "git" }),
  );
  assert.deepEqual(result, commands);
});

test("生成链路仍先拒绝未声明引用，不能被 use 模板适配放行", async () => {
  await assert.rejects(
    () =>
      generateValidatedCommandCandidates(
        createProviderWithRawText(
          JSON.stringify({ commands: [validCommand("git {{undeclared}}")] }),
        ),
        createRequest({ useCommand: "git" }),
      ),
    (error: unknown) =>
      error instanceof AiResponseValidationError &&
      error.message.includes("undeclared placeholder"),
  );
});

function createProviderWithRawText(rawText: string): CommandProvider {
  return {
    generateCommands() {
      return Promise.resolve({ rawText });
    },
  };
}

function createRequest(overrides: Partial<GenerateCommandsRequest> = {}): GenerateCommandsRequest {
  return {
    question: "show repo status",
    arguments: [],
    structuredOutput: true,
    outputContract: "contract",
    safetyConstraints: "safety",
    systemPrompt: "system",
    userPrompt: "user",
    ...overrides,
  };
}

function validCommand(command: string) {
  return {
    title: command,
    command,
    description: `Run ${command}`,
    placeholders: [],
  };
}
