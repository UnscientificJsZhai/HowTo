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
            command: 'find . -name "{{filename}}"',
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
          command: 'find . -name "{{filename}}"',
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

test("parseAndValidateAiResponse allows CR and LF in terminal-visible fields", () => {
  const response = parseAndValidateAiResponse(
    JSON.stringify({
      commands: [
        {
          title: "Print first\r\nthen second",
          command: "printf first\r\nprintf {{value}}",
          description: "Print two\nlines",
          placeholders: [
            {
              name: "value",
              description: "Value on\r\nmultiple lines",
            },
          ],
        },
      ],
    }),
  );

  assert.equal(response.commands[0]?.command, "printf first\r\nprintf {{value}}");
});

test("parseAndValidateAiResponse rejects every unsafe C0, DEL, and C1 character", () => {
  const unsafeCodePoints = [
    ...range(0x00, 0x09),
    ...range(0x0b, 0x0c),
    ...range(0x0e, 0x1f),
    ...range(0x7f, 0x9f),
  ];

  for (const codePoint of unsafeCodePoints) {
    const controlCharacter = String.fromCodePoint(codePoint);
    assert.throws(
      () =>
        parseAndValidateAiResponse(
          JSON.stringify({
            commands: [
              {
                ...validCommand("Safe command"),
                command: `printf safe${controlCharacter}git status`,
              },
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof AiResponseValidationError &&
        /commands\[0\]\.command.*control characters/u.test(error.message),
      `expected U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} to be rejected`,
    );
  }
});

test("parseAndValidateAiResponse rejects unsafe controls in every AI string field", () => {
  const candidates = [
    { ...validCommand("pwd"), title: "Title\bhidden" },
    { ...validCommand("pwd"), command: "truncate -s 0 important.file #\b\b\bgit status" },
    { ...validCommand("pwd"), description: "Description\u001B[2Jhidden" },
    {
      ...validCommand("printf {{value}}"),
      placeholders: [{ name: "value", description: "Value\u009B2Jhidden" }],
    },
    {
      ...validCommand("printf {{value}}"),
      placeholders: [{ name: "val\u0000ue", description: "Value" }],
    },
  ];

  for (const candidate of candidates) {
    assert.throws(
      () => parseAndValidateAiResponse(JSON.stringify({ commands: [candidate] })),
      AiResponseValidationError,
    );
  }
});

test("parseAndValidateAiResponse does not reflect invalid placeholder text in errors", () => {
  const injectedReference = "INJECTED_LEFT\r\nINJECTED_RIGHT";

  assert.throws(
    () =>
      parseAndValidateAiResponse(
        JSON.stringify({
          commands: [
            {
              ...validCommand("Safe command"),
              command: `printf '{{${injectedReference}}}'`,
            },
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof AiResponseValidationError &&
      error.message === "commands[0].command contains an invalid placeholder reference" &&
      !error.message.includes("INJECTED_LEFT") &&
      !error.message.includes("INJECTED_RIGHT") &&
      !error.message.includes("\r") &&
      !error.message.includes("\n"),
  );
});

test("parseAndValidateAiResponse rejects non JSON text", () => {
  assert.throws(() => parseAndValidateAiResponse("not-json"), AiResponseValidationError);
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
              command: 'find . -name "{{filename}}"',
              placeholders: [],
            },
          ],
        }),
      ),
    (error: unknown) =>
      error instanceof AiResponseValidationError &&
      error.message === "commands[0].command references an undeclared placeholder" &&
      !error.message.includes("filename"),
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
    (error: unknown) =>
      error instanceof AiResponseValidationError &&
      error.message === "commands[0].placeholders contains an unused placeholder" &&
      !error.message.includes("filename"),
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

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}
