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
            dangerous: false,
            dangerReason: "",
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
          dangerous: false,
          dangerReason: "",
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
          dangerous: false,
          dangerReason: "",
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

test("危险标记和原因按候选独立保留，原因允许 CR 和 LF", () => {
  const commands = [
    validCommand("查询"),
    {
      ...validCommand("重置"),
      command: "git reset --hard",
      dangerous: true,
      dangerReason: "会丢弃未提交的修改\r\n请确认已备份",
    },
  ];
  assert.deepEqual(parseAndValidateAiResponse(JSON.stringify({ commands })), { commands });
});

test("危险标记必须是显式布尔值，不接受缺失或类型转换", () => {
  for (const dangerous of [undefined, null, "true", "false", 0, 1, [], {}]) {
    assert.throws(
      () =>
        parseAndValidateAiResponse(
          JSON.stringify({ commands: [{ ...validCommand("测试"), dangerous }] }),
        ),
      (error: unknown) =>
        error instanceof AiResponseValidationError &&
        error.message === "commands[0].dangerous must be a boolean",
    );
  }
});

test("危险原因必填且必须是字符串，错误不回显候选内容", () => {
  for (const dangerReason of [undefined, null, true, 0, [], { value: "PRIVATE_SENTINEL" }]) {
    assert.throws(
      () =>
        parseAndValidateAiResponse(
          JSON.stringify({
            commands: [
              validCommand("有效候选"),
              { ...validCommand("PRIVATE_SENTINEL"), dangerous: true, dangerReason },
            ],
          }),
        ),
      (error: unknown) =>
        error instanceof AiResponseValidationError &&
        error.message === "commands[1].dangerReason must be a string",
    );
  }
});

test("危险原因不能为空白，未标记时原因必须严格为空字符串", () => {
  for (const [dangerous, reasons, expected] of [
    [true, ["", " ", "\r\n"], "must be a non-empty string"],
    [false, [" ", "\r\n", "PRIVATE_SENTINEL"], "must be empty when dangerous is false"],
  ] as const) {
    for (const dangerReason of reasons) {
      assert.throws(
        () =>
          parseAndValidateAiResponse(
            JSON.stringify({ commands: [{ ...validCommand("测试"), dangerous, dangerReason }] }),
          ),
        (error: unknown) =>
          error instanceof AiResponseValidationError &&
          error.message === `commands[0].dangerReason ${expected}`,
      );
    }
  }
});

test("危险原因拒绝除 CR 和 LF 外的 C0、DEL 和 C1，不回显原值", () => {
  for (const char of ["\x00", "\x07", "\x08", "\x1b", "\x7f", "\x80", "\x9f"]) {
    const dangerReason = `PRIVATE_LEFT${char}PRIVATE_RIGHT`;
    assert.throws(
      () =>
        parseAndValidateAiResponse(
          JSON.stringify({
            commands: [{ ...validCommand("测试"), dangerous: true, dangerReason }],
          }),
        ),
      (error: unknown) =>
        error instanceof AiResponseValidationError &&
        error.message ===
          "commands[0].dangerReason must not contain terminal control characters other than CR or LF",
    );
  }
});

function validCommand(title: string) {
  return {
    title,
    command: "pwd",
    description: "Print working directory",
    dangerous: false,
    dangerReason: "",
    placeholders: [],
  };
}
