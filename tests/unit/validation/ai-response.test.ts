import assert from "node:assert/strict";
import test from "node:test";

import {
  AiResponseValidationError,
  parseAndValidateAiResponse,
} from "../../../src/validation/ai-response.js";

test("parseAndValidateAiResponse accepts a valid command contract", () => {
  assert.deepEqual(
    parseAndValidateAiResponse(
      JSON.stringify({
        commands: [
          {
            title: "Find by filename",
            command: "find . -name \"{{filename}}\"",
            description: "Search from the current directory",
            placeholders: [
              {
                name: "filename",
                description: "The file name to find",
              },
            ],
          },
        ],
      }),
    ),
    {
      commands: [
        {
          title: "Find by filename",
          command: "find . -name \"{{filename}}\"",
          description: "Search from the current directory",
          placeholders: [
            {
              name: "filename",
              description: "The file name to find",
            },
          ],
        },
      ],
    },
  );
});

test("parseAndValidateAiResponse rejects non JSON text", () => {
  assert.throws(
    () => parseAndValidateAiResponse("not-json"),
    AiResponseValidationError,
  );
});

test("parseAndValidateAiResponse rejects more than three commands", () => {
  assert.throws(
    () =>
      parseAndValidateAiResponse(
        JSON.stringify({
          commands: [validCommand("a"), validCommand("b"), validCommand("c"), validCommand("d")],
        }),
      ),
    AiResponseValidationError,
  );
});

test("parseAndValidateAiResponse rejects undeclared placeholders", () => {
  assert.throws(
    () =>
      parseAndValidateAiResponse(
        JSON.stringify({
          commands: [
            {
              ...validCommand("Find"),
              command: "find . -name \"{{filename}}\"",
              placeholders: [],
            },
          ],
        }),
      ),
    AiResponseValidationError,
  );
});

test("parseAndValidateAiResponse rejects unused placeholders", () => {
  assert.throws(
    () =>
      parseAndValidateAiResponse(
        JSON.stringify({
          commands: [
            {
              ...validCommand("Find"),
              placeholders: [
                {
                  name: "filename",
                  description: "The file name to find",
                },
              ],
            },
          ],
        }),
      ),
    AiResponseValidationError,
  );
});

function validCommand(title: string) {
  return {
    title,
    command: "pwd",
    description: "Print working directory",
    placeholders: [],
  };
}
