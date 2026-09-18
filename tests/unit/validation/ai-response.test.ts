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
      error.message === "commands[0].command contains an invalid placeholder reference",
  );
});

test("parseAndValidateAiResponse rejects non JSON text", () => {
  assert.throws(() => parseAndValidateAiResponse("not json"), AiResponseValidationError);
});

test("parseAndValidateAiResponse rejects more than three commands", () => {
  assert.throws(
    () =>
      parseAndValidateAiResponse(
        JSON.stringify({
          commands: [validCommand("1"), validCommand("2"), validCommand("3"), validCommand("4")],
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
      error.message === "commands[0].command references an undeclared placeholder",
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
      error.message === "commands[0].placeholders contains an unused placeholder",
  );
});

test("同一候选拒绝重复占位符声明，不回显名称或描述", () => {
  for (const description of ["第一个值", "第二个值"]) {
    assert.throws(
      () =>
        parseAndValidateAiResponse(
          JSON.stringify({
            commands: [
              {
                ...validCommand("重复声明"),
                command: 'printf "%s %s" "{{PRIVATE_NAME}}" "{{PRIVATE_NAME}}"',
                placeholders: [
                  { name: "PRIVATE_NAME", description: "第一个值" },
                  { name: "PRIVATE_NAME", description },
                ],
              },
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof AiResponseValidationError &&
        error.message === "commands[0].placeholders must have unique names",
    );
  }
});

test("占位符可重复引用、跨候选复用名称，并保留大小写区别与声明顺序", () => {
  const commands = [
    {
      ...validCommand("重复引用"),
      command: 'printf "%s %s %s" "{{value}}" "{{Value}}" "{{value}}"',
      placeholders: [
        { name: "Value", description: "大写名称" },
        { name: "value", description: "小写名称" },
      ],
    },
    {
      ...validCommand("另一个候选"),
      command: "printf {{value}}",
      placeholders: [{ name: "value", description: "独立输入" }],
    },
  ];
  assert.deepEqual(parseAndValidateAiResponse(JSON.stringify({ commands })), { commands });
});

function validCommand(title: string) {
  return {
    title,
    command: "pwd",
    description: "Print working directory",
    placeholders: [],
  };
}
