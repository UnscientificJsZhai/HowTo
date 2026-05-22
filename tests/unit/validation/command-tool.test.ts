import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateUsesRequestedCommand,
  validateUseCommandCandidates,
} from "../../../src/validation/command-tool.js";
import { AiResponseValidationError } from "../../../src/validation/ai-response.js";

test("candidateUsesRequestedCommand accepts direct requested command", () => {
  assert.equal(candidateUsesRequestedCommand("git status", "git"), true);
});

test("candidateUsesRequestedCommand accepts sudo and environment prefixes", () => {
  assert.equal(candidateUsesRequestedCommand("FOO=bar sudo git status", "git"), true);
});

test("candidateUsesRequestedCommand accepts env prefixes", () => {
  assert.equal(candidateUsesRequestedCommand("env FOO=bar git status", "git"), true);
});

test("candidateUsesRequestedCommand rejects shell wrappers", () => {
  assert.equal(candidateUsesRequestedCommand('sh -c "git status"', "git"), false);
});

test("validateUseCommandCandidates rejects commands that do not use requested tool", () => {
  assert.throws(
    () =>
      validateUseCommandCandidates(
        {
          commands: [
            {
              title: "List files",
              command: "ls",
              description: "List files",
              placeholders: [],
            },
          ],
        },
        "git",
      ),
    AiResponseValidationError,
  );
});
