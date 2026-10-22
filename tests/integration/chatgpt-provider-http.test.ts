import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import test, { type TestContext } from "node:test";

import { ChatGptCommandProvider } from "../../src/ai/chatgpt.js";
import { ChatGptError } from "../../src/auth/chatgpt/errors.js";
import { AiProviderError } from "../../src/ai/errors.js";
import { InteractionCancelledError } from "../../src/ui/tty.js";
import { testRequest } from "../unit/ui/session-test-helpers.js";
import {
  CHATGPT_TEST_CATALOG,
  CHATGPT_TEST_MODEL,
  CHATGPT_TEST_SECRET,
  CHATGPT_TEST_TEXT,
  CHATGPT_TEST_TOKEN,
  chatGptTestCompleted,
  chatGptTestFrame,
  chatGptSubscriptionTestCompleted,
} from "./fixtures/chatgpt-test-data.js";

async function loopbackProvider(
  t: TestContext,
  listener: RequestListener,
  timeoutMilliseconds?: number,
): Promise<ChatGptCommandProvider> {
  const server = createServer((request, response) => {
    request.resume();
    assert.equal(request.headers.authorization, `Bearer ${CHATGPT_TEST_TOKEN}`);
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(CHATGPT_TEST_CATALOG));
      return;
    }
    listener(request, response);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return new ChatGptCommandProvider(
    { model: CHATGPT_TEST_MODEL },
    {
      getAccessToken: () =>
        Promise.resolve({ accessToken: CHATGPT_TEST_TOKEN, accountId: "test-account" }),
      timeoutMilliseconds,
      fetch: (input, init) => {
        const url = new URL(new Request(input, init).url);
        assert.equal(url.origin, "https://api.openai.com");
        return fetch(`http://127.0.0.1:${address.port}${url.pathname}`, init);
      },
    },
  );
}

test(
  "ChatGPT loopback HTTP: SSE 完成后返回最终文本并关闭未结束的连接",
  { timeout: 5000 },
  async (t) => {
    let closed!: () => void;
    const connectionClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const provider = await loopbackProvider(t, (_request, response) => {
      response.on("close", closed);
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(chatGptTestCompleted());
    });
    assert.deepEqual(await provider.generateCommands(testRequest()), {
      rawText: CHATGPT_TEST_TEXT,
    });
    await connectionClosed;
  },
);

test(
  "ChatGPT loopback HTTP: 缺少 Content-Type 且完成事件输出为空时使用已结束的完整项",
  { timeout: 5000 },
  async (t) => {
    const provider = await loopbackProvider(t, (_request, response) => {
      response.writeHead(200);
      response.end(chatGptSubscriptionTestCompleted());
    });
    assert.deepEqual(await provider.generateCommands(testRequest()), {
      rawText: CHATGPT_TEST_TEXT,
    });
  },
);

test(
  "ChatGPT loopback HTTP: 部分输出后取消、断流与超时均不返回命令",
  { timeout: 5000 },
  async (t) => {
    for (const mode of ["abort", "disconnect", "timeout"] as const) {
      await t.test(mode, async (child) => {
        let started!: () => void;
        const ready = new Promise<void>((resolve) => {
          started = resolve;
        });
        const provider = await loopbackProvider(
          child,
          (_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(
              chatGptTestFrame({ type: "response.output_text.delta", delta: CHATGPT_TEST_TEXT }),
            );
            started();
            if (mode === "disconnect") response.socket?.destroy();
          },
          mode === "timeout" ? 50 : undefined,
        );
        const controller = new AbortController();
        const result = provider.generateCommands(testRequest(), controller.signal);
        const rejection = assert.rejects(
          result,
          mode === "abort" ? InteractionCancelledError : AiProviderError,
        );
        await ready;
        if (mode === "abort") controller.abort(new Error(CHATGPT_TEST_SECRET));
        await rejection;
      });
    }
  },
);

test(
  "ChatGPT loopback HTTP: 429/503/重定向只请求一次，不重试或切换计费路径",
  { timeout: 5000 },
  async (t) => {
    for (const status of [429, 503, 302]) {
      await t.test(String(status), async (child) => {
        let requests = 0;
        const provider = await loopbackProvider(child, (_request, response) => {
          requests++;
          response.writeHead(status, {
            "content-type": "application/json",
            location: "https://unexpected.invalid/credential-target",
            "retry-after": "1",
          });
          response.end(JSON.stringify({ error: { message: CHATGPT_TEST_SECRET } }));
        });
        await assert.rejects(provider.generateCommands(testRequest()), (error: unknown) => {
          assert.ok(error instanceof ChatGptError || error instanceof AiProviderError);
          assert.doesNotMatch(error.message, /HOWTO_FAKE|unexpected/);
          return true;
        });
        assert.equal(requests, 1);
      });
    }
  },
);
