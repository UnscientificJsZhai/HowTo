import assert from "node:assert/strict";
import test from "node:test";
import {
  type ChatGptDependencies,
  listChatGptModels,
  parseChatGptModels,
} from "../../src/ai/chatgpt-models.js";
import { ChatGptCommandProvider, buildChatGptResponseRequest } from "../../src/ai/chatgpt.js";
import { COMMAND_GENERATION_SCHEMA } from "../../src/ai/command-schema.js";
import { AiProviderError } from "../../src/ai/errors.js";
import { ChatGptError } from "../../src/auth/chatgpt/errors.js";
import { ConfigError } from "../../src/config.js";
import { InteractionCancelledError } from "../../src/ui/tty.js";
import { testRequest } from "../helpers/interactive-session.js";

const MODEL = "chatgpt-test";
const TOKEN = "howto-fake-chatgpt-token";
const CATALOG = {
  models: [
    { slug: MODEL, display_name: "ChatGPT Test", visibility: "list" },
    { slug: "hidden", display_name: "Hidden", visibility: "hide" },
    { slug: "second", display_name: "Second", visibility: "list" },
  ],
};
const RAW_TEXT = JSON.stringify({
  commands: [
    {
      title: "列出文件",
      command: "ls",
      description: "查看当前目录",
      dangerous: false,
      dangerReason: "",
      placeholders: [],
    },
  ],
});
const credentials: NonNullable<ChatGptDependencies["getAccessToken"]> = () =>
  Promise.resolve({ accessToken: TOKEN, accountId: "account-test" });

function message(text = RAW_TEXT): Record<string, unknown> {
  return {
    type: "message",
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

function completed(output: unknown[] = [message()]): Record<string, unknown> {
  return {
    type: "response.completed",
    response: { status: "completed", error: null, incomplete_details: null, output },
  };
}

function frame(event: unknown, name?: string): string {
  return `${name === undefined ? "" : `event: ${name}\n`}data: ${JSON.stringify(event)}\n\n`;
}

function doneItem(item: unknown = message(), index = 0): string {
  return frame({ type: "response.output_item.done", output_index: index, item });
}

function providerFor(
  body: BodyInit | null,
  options: { contentType?: string; omitContentType?: boolean; timeoutMilliseconds?: number } = {},
): ChatGptCommandProvider {
  return new ChatGptCommandProvider(
    { fast: false, model: MODEL, account: "account-test" },
    {
      getAccessToken: credentials,
      timeoutMilliseconds: options.timeoutMilliseconds,
      fetch: (input) => {
        if (new Request(input).url.endsWith("/models"))
          return Promise.resolve(Response.json(CATALOG));
        const response = new Response(body, {
          headers: { "content-type": options.contentType ?? "text/event-stream" },
        });
        if (options.omitContentType) response.headers.delete("content-type");
        return Promise.resolve(response);
      },
    },
  );
}

function assertProviderError(error: unknown): boolean {
  assert.ok(error instanceof AiProviderError);
  assert.equal(error.message, `AI provider request failed (provider: chatgpt, model: ${MODEL})`);
  return true;
}

test("ChatGPT 复用现有 schema，并使用 instructions、数组 input 和持久化关闭的流请求", () => {
  const source = testRequest();
  assert.deepEqual(buildChatGptResponseRequest(MODEL, source, false), {
    model: MODEL,
    service_tier: "default",
    instructions: source.systemPrompt,
    input: [{ role: "user", content: source.userPrompt }],
    store: false,
    stream: true,
    text: {
      format: {
        type: "json_schema",
        name: "command_generation",
        description: "Shell command candidates generated for howto.",
        schema: COMMAND_GENERATION_SCHEMA,
        strict: true,
      },
    },
  });
  const compatibilityRequest = buildChatGptResponseRequest(MODEL, {
    ...source,
    structuredOutput: false,
  });
  assert.deepEqual(compatibilityRequest.text, { format: { type: "json_object" } });
  assert.equal(compatibilityRequest.instructions, source.systemPrompt);
  assert.deepEqual(compatibilityRequest.input, [
    { role: "user", content: `Return JSON matching the instructions.\n${source.userPrompt}` },
  ]);
});

test("ChatGPT 模型目录只展示 list 项并保留账户返回的顺序", () => {
  assert.deepEqual(parseChatGptModels(CATALOG), [
    { slug: MODEL, displayName: "ChatGPT Test" },
    { slug: "second", displayName: "Second" },
  ]);
  assert.deepEqual(parseChatGptModels({ models: [] }), []);
});

test("ChatGPT 模型目录拒绝普通 API key 目录、缺失字段、重复标识和终端控制字符", () => {
  for (const body of [
    null,
    { data: [{ id: MODEL }] },
    { models: [null] },
    { models: [{ visibility: "list", display_name: "missing slug" }] },
    { models: [{ visibility: "list", slug: MODEL }] },
    { models: [CATALOG.models[0], CATALOG.models[0]] },
    { models: [{ visibility: "list", slug: MODEL, display_name: "bad\u001b[2J" }] },
    { models: [{ visibility: "list", slug: "bad\nslug", display_name: "Model" }] },
  ]) {
    assert.throws(() => parseChatGptModels(body), AiProviderError);
  }
});

test("ChatGPT 目录每次使用所选账户令牌，不复用另一账户的缓存", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  const accounts: (string | undefined)[] = [];
  const dependencies: ChatGptDependencies = {
    getAccessToken: (options) => {
      accounts.push(options.accountId);
      return Promise.resolve({
        accessToken: `fake-${options.accountId ?? "default"}`,
        accountId: options.accountId ?? "default",
      });
    },
    fetch: (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, authorization: request.headers.get("Authorization") });
      assert.equal(request.method, "GET");
      assert.equal(request.redirect, "error");
      return Promise.resolve(Response.json(CATALOG));
    },
  };
  await listChatGptModels({ accountId: "first" }, dependencies);
  await listChatGptModels({ accountId: "second" }, dependencies);
  assert.deepEqual(accounts, ["first", "second"]);
  assert.deepEqual(requests, [
    { url: "https://api.openai.com/v1/models", authorization: "Bearer fake-first" },
    { url: "https://api.openai.com/v1/models", authorization: "Bearer fake-second" },
  ]);
});

test("ChatGPT 模型必须显式选择，不自动选默认模型", () => {
  for (const model of [undefined, "", " "])
    assert.throws(() => new ChatGptCommandProvider({ fast: false, model }), ConfigError);
});

test("ChatGPT 保留认证层的明确恢复提示，不在授权缺失时访问模型或推理", async () => {
  let requests = 0;
  const expected = new ChatGptError("plan_permission");
  const dependencies: ChatGptDependencies = {
    getAccessToken: () => Promise.reject(expected),
    fetch: () => {
      requests++;
      return Promise.resolve(Response.json(CATALOG));
    },
  };
  await assert.rejects(listChatGptModels({}, dependencies), (error: unknown) => error === expected);
  await assert.rejects(
    new ChatGptCommandProvider({ fast: false, model: MODEL }, dependencies).generateCommands(
      testRequest(),
    ),
    (error: unknown) => error === expected,
  );
  assert.equal(requests, 0);
});

test("ChatGPT 推理的额度与过大错误按固定分类失败，不请求推理或重试", async () => {
  for (const body of [
    JSON.stringify({
      error: { code: "subscription_sharing_usage_limit_exceeded", message: "secret" },
    }),
    "secret".repeat(64 * 1024),
  ]) {
    let requests = 0;
    const provider = new ChatGptCommandProvider(
      { fast: false, model: MODEL },
      {
        getAccessToken: credentials,
        fetch: () => {
          requests++;
          return Promise.resolve(new Response(body, { status: 429 }));
        },
      },
    );
    await assert.rejects(provider.generateCommands(testRequest()), (error: unknown) => {
      assert.ok(error instanceof ChatGptError);
      assert.equal(error.code, "quota");
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.equal(requests, 1);
  }
});

test("ChatGPT 直接使用配置模型和固定公共推理端点", async () => {
  const requests: Request[] = [];
  let credentialReads = 0;
  const provider = new ChatGptCommandProvider(
    { fast: false, model: MODEL, account: "account-test" },
    {
      getAccessToken: (options) => {
        assert.equal(options.accountId, "account-test");
        credentialReads++;
        return credentials(options);
      },
      fetch: (input, init) => {
        requests.push(new Request(input, init));
        return Promise.resolve(
          new Response(frame(completed()), {
            headers: { "content-type": "text/event-stream" },
          }),
        );
      },
    },
  );
  assert.deepEqual(await provider.generateCommands(testRequest()), { rawText: RAW_TEXT });
  assert.equal(credentialReads, 1);
  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests.map((request) => [request.url, request.method, request.redirect]),
    [["https://api.openai.com/v1/responses", "POST", "error"]],
  );
  for (const request of requests) {
    assert.equal(request.headers.get("authorization"), `Bearer ${TOKEN}`);
  }
  assert.deepEqual(
    await requests[0].json(),
    buildChatGptResponseRequest(MODEL, testRequest(), false),
  );
});

test("ChatGPT 只读取终态文本，不重复 delta，也不混入 reasoning 或 commentary", async () => {
  const output = [
    { type: "reasoning", summary: [{ text: "private reasoning" }] },
    { ...message("private commentary"), phase: "commentary" },
    { ...message(), phase: "final_answer" },
  ];
  const body =
    frame({ type: "response.output_text.delta", delta: RAW_TEXT }) +
    frame({ type: "response.output_text.done", text: RAW_TEXT }) +
    frame(completed(output));
  assert.deepEqual(await providerFor(body).generateCommands(testRequest()), { rawText: RAW_TEXT });
});

test("ChatGPT 接受真实订阅流的缺失 Content-Type 和空 completed.output，但必须已有完整 done 项", async () => {
  const body =
    frame({ type: "response.output_text.delta", delta: "partial text must not be returned" }) +
    frame({ type: "response.output_text.done", text: RAW_TEXT }) +
    frame({ type: "response.content_part.done", part: { type: "output_text", text: RAW_TEXT } }) +
    doneItem({ ...message(), phase: "final_answer" }) +
    frame(completed([]));
  for (const omitContentType of [false, true]) {
    assert.deepEqual(await providerFor(body, { omitContentType }).generateCommands(testRequest()), {
      rawText: RAW_TEXT,
    });
  }
  assert.deepEqual(
    await providerFor(doneItem() + frame(completed())).generateCommands(testRequest()),
    { rawText: RAW_TEXT },
  );
});

test("ChatGPT 的 done 项按输出索引排序，reasoning 和 commentary 不进入结果", async () => {
  const midpoint = Math.floor(RAW_TEXT.length / 2);
  const body =
    doneItem(message(RAW_TEXT.slice(midpoint)), 3) +
    doneItem({ type: "reasoning", status: "completed", summary: [] }, 0) +
    doneItem(message(RAW_TEXT.slice(0, midpoint)), 2) +
    doneItem({ ...message("private commentary"), phase: "commentary" }, 1) +
    frame(completed([]));
  assert.deepEqual(await providerFor(body).generateCommands(testRequest()), { rawText: RAW_TEXT });
});

test("ChatGPT 已结束的项在全局 completed 之前不能提前返回，取消时丢弃缓存", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(doneItem()));
        started();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const controller = new AbortController();
  const rejection = assert.rejects(
    providerFor(stream, { omitContentType: true }).generateCommands(
      testRequest(),
      controller.signal,
    ),
    InteractionCancelledError,
  );
  await ready;
  controller.abort();
  await rejection;
  assert.equal(cancelled, true);
});

test("ChatGPT done 项后的失败事件不能成为成功结果", async () => {
  const body = doneItem() + frame({ type: "response.failed", response: { status: "failed" } });
  await assert.rejects(
    providerFor(body, { omitContentType: true }).generateCommands(testRequest()),
    ChatGptError,
  );
});

for (const newline of ["\n", "\r\n", "\r"]) {
  test(`ChatGPT SSE 支持 ${JSON.stringify(newline)}、多 data 行和 UTF-8 字节分片`, async () => {
    const json = JSON.stringify(completed(), null, 2);
    const body = [
      ": heartbeat",
      "event: response.completed",
      "id: test-id",
      "retry: 1000",
      ...json.split("\n").map((line) => `data: ${line}`),
      "",
      "",
    ].join(newline);
    const encoded = new TextEncoder().encode(body);
    const boundaries = [
      newline === "\r\n" ? body.indexOf("\r\n") + 1 : 20,
      encoded.findIndex((byte) => (byte & 0x80) !== 0) + 1,
      encoded.findIndex((byte) => (byte & 0x80) !== 0) + 30,
    ];
    const chunks = [
      encoded.subarray(0, boundaries[0]),
      encoded.subarray(boundaries[0], boundaries[1]),
      encoded.subarray(boundaries[1], boundaries[2]),
      encoded.subarray(boundaries[2]),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    assert.deepEqual(await providerFor(stream).generateCommands(testRequest()), {
      rawText: RAW_TEXT,
    });
  });
}

test("ChatGPT 忽略未知事件中的坏 JSON，并在完整终态到达后关闭流", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          "event: thread.unknown\ndata: bad secret JSON\n\n" + frame(completed()),
        ),
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.deepEqual(await providerFor(stream).generateCommands(testRequest()), {
    rawText: RAW_TEXT,
  });
  assert.equal(cancelled, true);
});

for (const [name, body] of [
  ["只有 DONE", "data: [DONE]\n\n"],
  ["没有终态", frame({ type: "response.output_text.delta", delta: RAW_TEXT })],
  ["终态缺少空行", frame(completed()).slice(0, -1)],
  ["坏 JSON", "data: HOWTO_FAKE_STREAM_SECRET\n\n"],
  ["event 名字与 type 不同", frame(completed(), "response.incomplete")],
  ["不完整终态", frame({ type: "response.incomplete", response: { output: [message()] } })],
  [
    "拒绝 delta",
    frame({ type: "response.refusal.delta", delta: "private refusal" }) + frame(completed()),
  ],
  [
    "拒绝 done",
    frame({ type: "response.refusal.done", refusal: "private refusal" }) + frame(completed()),
  ],
  [
    "拒绝内容片段",
    frame({
      type: "response.content_part.done",
      part: { type: "refusal", refusal: "private refusal" },
    }) + frame(completed()),
  ],
  [
    "终态状态不一致",
    frame({ ...completed(), response: { status: "failed", output: [message()] } }),
  ],
  [
    "终态附带错误",
    frame({
      ...completed(),
      response: { status: "completed", error: { message: "private error" }, output: [message()] },
    }),
  ],
  ["终态仅有 commentary", frame(completed([{ ...message(), phase: "commentary" }]))],
  [
    "终态拒绝",
    frame(
      completed([{ ...message(), content: [{ type: "refusal", refusal: "private refusal" }] }]),
    ),
  ],
  ["终态消息不完整", frame(completed([{ ...message(), status: "incomplete" }]))],
  [
    "工具调用",
    frame(completed([{ type: "function_call", name: "run_command", arguments: "private" }])),
  ],
  ["空文本", frame(completed([message(" \n ")]))],
  [
    "错误文本类型",
    frame(completed([{ ...message(), content: [{ type: "output_text", text: 7 }] }])),
  ],
  ["空输出", frame(completed([]))],
  [
    "只有 delta 和空 completed",
    frame({ type: "response.output_text.delta", delta: RAW_TEXT }) + frame(completed([])),
  ],
  [
    "只有 text.done 和空 completed",
    frame({ type: "response.output_text.done", text: RAW_TEXT }) + frame(completed([])),
  ],
  [
    "只有 content_part.done 和空 completed",
    frame({ type: "response.content_part.done", part: { type: "output_text", text: RAW_TEXT } }) +
      frame(completed([])),
  ],
  ["done 项后断流", doneItem()],
  ["done 项后未结束的 completed 帧", doneItem() + frame(completed([])).slice(0, -1)],
  ["done 项后 incomplete", doneItem() + frame({ type: "response.incomplete" })],
  ["done 项后拒绝", doneItem() + frame({ type: "response.refusal.done", refusal: "private" })],
  ["done 项状态不完整", doneItem({ ...message(), status: "incomplete" }) + frame(completed([]))],
  ["done 项缺失状态", doneItem({ ...message(), status: undefined }) + frame(completed([]))],
  [
    "done 项拒绝",
    doneItem({ ...message(), content: [{ type: "refusal", refusal: "private" }] }) +
      frame(completed([])),
  ],
  ["done 项缺失", doneItem(null) + frame(completed([]))],
  ["done 项类型错误", doneItem({ type: "function_call" }) + frame(completed([]))],
  ["done 项索引为负", doneItem(message(), -1) + frame(completed([]))],
  ["done 项索引不是整数", doneItem(message(), 0.5) + frame(completed([]))],
  [
    "done 项缺失索引",
    frame({ type: "response.output_item.done", item: message() }) + frame(completed([])),
  ],
  ["done 项索引重复", doneItem() + doneItem() + frame(completed([]))],
] as const) {
  test(`ChatGPT ${name}不能成为成功结果`, async () => {
    await assert.rejects(providerFor(body).generateCommands(testRequest()), assertProviderError);
  });
}

test("ChatGPT 拒绝非 SSE 响应和非法 UTF-8 字节", async () => {
  await assert.rejects(
    providerFor(JSON.stringify(completed()), { contentType: "application/json" }).generateCommands(
      testRequest(),
    ),
    assertProviderError,
  );
  await assert.rejects(
    providerFor(new Uint8Array([0xff, 0xfe])).generateCommands(testRequest()),
    assertProviderError,
  );
  await assert.rejects(
    providerFor(JSON.stringify(completed()), { omitContentType: true }).generateCommands(
      testRequest(),
    ),
    assertProviderError,
  );
  await assert.rejects(
    providerFor(doneItem() + frame(completed([])), { contentType: "text/plain" }).generateCommands(
      testRequest(),
    ),
    assertProviderError,
  );
});

test("ChatGPT 对目录、单个 SSE 块和最终输出设置独立的字节上限", async () => {
  await assert.rejects(
    listChatGptModels(
      {},
      {
        getAccessToken: credentials,
        fetch: () => Promise.resolve(new Response(" ".repeat(1024 * 1024 + 1))),
      },
    ),
    AiProviderError,
  );
  await assert.rejects(
    providerFor("data: " + "x".repeat(2 * 1024 * 1024)).generateCommands(testRequest()),
    assertProviderError,
  );
  await assert.rejects(
    providerFor(frame(completed([message("字".repeat(100_000))]))).generateCommands(testRequest()),
    assertProviderError,
  );
  await assert.rejects(
    providerFor(
      doneItem(message("字".repeat(50_000))) +
        doneItem(message("字".repeat(50_000)), 1) +
        frame(completed([])),
    ).generateCommands(testRequest()),
    assertProviderError,
  );
});

test("ChatGPT 预取消不读取凭证，流中取消丢弃已有文本并关闭 reader", async () => {
  const controller = new AbortController();
  controller.abort(new Error("private reason"));
  let credentialReads = 0;
  const provider = new ChatGptCommandProvider(
    { fast: false, model: MODEL },
    {
      getAccessToken: (options) => {
        credentialReads++;
        return credentials(options);
      },
    },
  );
  await assert.rejects(
    provider.generateCommands(testRequest(), controller.signal),
    InteractionCancelledError,
  );
  assert.equal(credentialReads, 0);

  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(frame({ type: "response.output_text.delta", delta: RAW_TEXT })),
        );
        started();
        return new Promise<void>(() => undefined);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const activeController = new AbortController();
  const result = providerFor(stream).generateCommands(testRequest(), activeController.signal);
  const rejection = assert.rejects(result, InteractionCancelledError);
  await ready;
  activeController.abort(new Error("private reason"));
  await rejection;
  assert.equal(cancelled, true);
});

test("ChatGPT 超时覆盖凭证与流读取，即使依赖不主动响应 signal 也结束等待", async () => {
  const provider = new ChatGptCommandProvider(
    { fast: false, model: MODEL },
    {
      timeoutMilliseconds: 10,
      getAccessToken: () => new Promise(() => undefined),
    },
  );
  await assert.rejects(provider.generateCommands(testRequest()), assertProviderError);
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    providerFor(stream, { timeoutMilliseconds: 10 }).generateCommands(testRequest()),
    assertProviderError,
  );
  assert.equal(cancelled, true);
});
