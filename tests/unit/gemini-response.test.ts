import assert from "node:assert/strict";
import test from "node:test";
import { extractGeminiResponseText, GeminiCommandProvider } from "../../src/ai/gemini.js";
import { AiProviderError } from "../../src/ai/errors.js";
import type { GenerateCommandsRequest } from "../../src/ai/types.js";

test("Gemini 只拼接首候选的非 thought 文本，不增加分隔符或裁剪", () => {
  const response = {
    candidates: [
      {
        content: {
          parts: [
            { text: " first " },
            { thought: true, text: "ignored" },
            { inlineData: { data: "ignored" } },
            { thought: false, text: "\nsecond ", thoughtSignature: "ignored" },
          ],
        },
      },
      { content: { parts: [{ text: "other candidate" }] } },
    ],
  };
  assert.equal(extractGeminiResponseText(response), " first \nsecond ");
});

test("Gemini 不访问 root text getter，不枚举或读取未知字段", () => {
  let getterReads = 0;
  const part = new Proxy(
    { text: "kept" },
    {
      ownKeys() {
        throw new Error("HOWTO_FAKE_UNKNOWN_FIELDS_SECRET");
      },
    },
  );
  Object.defineProperty(part, "unknown", {
    enumerable: true,
    get() {
      getterReads += 1;
      throw new Error("HOWTO_FAKE_PART_SECRET");
    },
  });
  const response = envelope([part]);
  Object.defineProperty(response, "text", {
    get() {
      getterReads += 1;
      throw new Error("HOWTO_FAKE_GETTER_SECRET");
    },
  });
  assert.equal(extractGeminiResponseText(response), "kept");
  assert.equal(getterReads, 0);
});

test("Gemini 整段忽略 thought，不读取它的 text", () => {
  const thought = { thought: true };
  Object.defineProperty(thought, "text", {
    get() {
      throw new Error("HOWTO_FAKE_THOUGHT_SECRET");
    },
  });
  assert.equal(extractGeminiResponseText(envelope([thought, { text: "kept" }])), "kept");
});

test("Gemini 不回退后续候选，空文本与无文本保持区别", () => {
  assert.equal(
    extractGeminiResponseText({
      candidates: [
        { content: { parts: [{ inlineData: {} }] } },
        { content: { parts: [{ text: "must not use" }] } },
      ],
    }),
    undefined,
  );
  assert.equal(extractGeminiResponseText(envelope([{ text: "" }])), "");
  assert.equal(extractGeminiResponseText(envelope([{ text: " \n " }])), " \n ");
  assert.equal(
    extractGeminiResponseText(envelope([{ thought: true, text: "ignored" }])),
    undefined,
  );
});

const invalidResponses: Array<[string, unknown]> = [
  ["根为空", null],
  ["根为字符串", "response"],
  ["根为数组", []],
  ["缺候选", {}],
  ["候选非数组", { candidates: {} }],
  ["候选为空", { candidates: [] }],
  ["首候选为空", { candidates: [null] }],
  ["首候选非对象", { candidates: [1] }],
  ["首候选为数组", { candidates: [[]] }],
  ["缺 content", { candidates: [{}] }],
  ["content 非对象", { candidates: [{ content: "content" }] }],
  ["content 为数组", { candidates: [{ content: [] }] }],
  ["缺 parts", { candidates: [{ content: {} }] }],
  ["parts 非数组", envelope({})],
  ["parts 为空", envelope([])],
  ["part 为空", envelope([{ text: "kept" }, null])],
  ["part 非对象", envelope(["text"])],
  ["part 为数组", envelope([[]])],
  ...[null, 1, "true", undefined].map((thought): [string, unknown] => [
    `thought 类型错误 ${String(thought)}`,
    envelope([{ text: "kept", thought }]),
  ]),
  ...[null, 1, {}, undefined].map((text): [string, unknown] => [
    `text 类型错误 ${text === null ? "null" : typeof text}`,
    envelope([{ text: "kept" }, { text }]),
  ]),
];

for (const [name, response] of invalidResponses) {
  test(`Gemini 拒绝异常 envelope：${name}`, () => {
    assert.equal(extractGeminiResponseText(response), undefined);
  });
}

test("Gemini 异常 envelope、空结果和 SDK 异常统一为固定 Provider 错误", async () => {
  const provider = new GeminiCommandProvider({ apiKey: "howto-fake-key", model: "gemini-test" });
  const request: GenerateCommandsRequest = {
    question: "list files",
    arguments: [],
    structuredOutput: true,
    outputContract: "contract",
    safetyConstraints: "safety",
    systemPrompt: "system",
    userPrompt: "user",
  };
  for (const response of [
    ...invalidResponses.map(([, response]) => response),
    envelope([{ text: "" }]),
    envelope([{ text: " \n " }]),
    envelope([{ inlineData: {} }]),
  ]) {
    Reflect.set(provider, "client", {
      models: { generateContent: () => Promise.resolve(response) },
    });
    await assert.rejects(() => provider.generateCommands(request), isFixedProviderError);
  }
  Reflect.set(provider, "client", {
    models: { generateContent: () => Promise.reject(new Error("HOWTO_FAKE_SDK_SECRET")) },
  });
  await assert.rejects(() => provider.generateCommands(request), isFixedProviderError);
});

function envelope(parts: unknown) {
  return { candidates: [{ content: { parts } }] };
}

function isFixedProviderError(error: unknown): boolean {
  return (
    error instanceof AiProviderError &&
    error.message === "AI provider request failed (provider: gemini, model: gemini-test)"
  );
}
