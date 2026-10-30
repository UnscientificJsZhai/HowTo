import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

// 只替换认证边界和网络；随后由 Node 正常启动隔离安装包的真实 CLI 入口。
const root = process.env.HOWTO_TEST_PACKAGE_ROOT;
assert.ok(root);
const authUrl = pathToFileURL(join(root, "dist/auth/chatgpt/index.js")).href;
const auth: unknown = await import(authUrl);
assert.ok(auth !== null && typeof auth === "object");
mock.module(authUrl, {
  exports: {
    ...auth,
    getChatGptAccessToken: () =>
      Promise.resolve({ accessToken: "offline-test-only", accountId: "offline" }),
  },
});

const mode = process.env.HOWTO_TEST_STREAM_MODE;
let requests = 0;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  requests++;
  if (request.url === "https://api.openai.com/v1/models") {
    return Promise.resolve(
      Response.json({
        models: [
          {
            slug: "offline-stream",
            display_name: "Offline stream",
            visibility: "list",
            service_tiers:
              mode === "fast-unknown" || mode === "fast-default-unknown"
                ? undefined
                : mode === "fast-unsupported"
                  ? []
                  : [{ id: "priority" }],
          },
        ],
      }),
    );
  }
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(typeof init?.body, "string");
  const body = JSON.parse(init?.body as string) as Record<string, unknown>;
  assert.equal(body.service_tier, mode?.startsWith("fast-") ? "priority" : "default");
  if (mode === "fast-unsupported")
    return Promise.resolve(
      Response.json({ error: { code: "unsupported_service_tier" } }, { status: 400 }),
    );
  if (mode === "http-error") {
    return Promise.resolve(Response.json({ message: "UPSTREAM_PRIVATE_DETAIL" }, { status: 403 }));
  }
  const text = JSON.stringify({
    commands: [
      {
        title: "离线流",
        command: "printf 'STREAM_OK\\n'",
        description: "只打印",
        dangerous: false,
        dangerReason: "",
        placeholders: [],
      },
    ],
  });
  const event =
    mode === "incomplete"
      ? { type: "response.output_text.delta", delta: text }
      : {
          type: "response.completed",
          response: {
            status: "completed",
            service_tier:
              mode === "fast-downgrade"
                ? "default"
                : mode === "fast-missing"
                  ? undefined
                  : "priority",
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text }],
              },
            ],
          },
        };
  const bytes = Buffer.from(`data: ${JSON.stringify(event)}\r\n\r\n`);
  let offset = 0;
  return Promise.resolve(
    new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          // 单字节边界覆盖 UTF-8、CRLF 和 SSE frame 分片。
          await delay(1);
          if (offset === bytes.length) controller.close();
          else controller.enqueue(bytes.subarray(offset, ++offset));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ),
  );
};
process.once("beforeExit", () => assert.equal(requests, mode === "fast-unsupported" ? 2 : 1));
