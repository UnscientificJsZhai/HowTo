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

test("generateValidatedCommandCandidates rejects shell wrapped requested commands", async () => {
  await assert.rejects(
    () =>
      generateValidatedCommandCandidates(
        createProviderWithRawText(
          JSON.stringify({
            commands: [validCommand('sh -c "git status"')],
          }),
        ),
        createRequest({ useCommand: "git" }),
      ),
    AiResponseValidationError,
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
