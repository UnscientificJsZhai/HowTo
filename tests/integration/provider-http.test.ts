import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { OpenAiCommandProvider } from "../../src/ai/openai.js";
import { testRequest } from "../unit/ui/session-test-helpers.js";

test("真实 loopback HTTP: AbortSignal 中断请求", { timeout: 10000 }, async (t) => {
  let startedResolve!: () => void;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const server = createServer((req) => {
    req.resume();
    startedResolve();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new OpenAiCommandProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    model: "offline-test",
  });
  const controller = new AbortController();
  const result = provider.generateCommands(testRequest(), controller.signal);
  const rejection = assert.rejects(result);
  await started;
  controller.abort();
  await rejection;
});

test("真实 loopback HTTP: 连接意外中断时安全失败", { timeout: 10000 }, async (t) => {
  const server = createServer((req, res) => {
    req.resume();
    res.destroy();
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new OpenAiCommandProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    model: "offline-test",
  });
  await assert.rejects(provider.generateCommands(testRequest()));
});

test("真实 loopback HTTP: 429/500 错误脱敏，不泄露原始响应信息", { timeout: 10000 }, async () => {
  for (const status of [429, 500]) {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(status, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ error: { message: "FAKE_PRIVATE_HTTP_RESPONSE" } }));
    });
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const provider = new OpenAiCommandProvider({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "",
        model: "offline-test",
      });
      await assert.rejects(provider.generateCommands(testRequest()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("FAKE_PRIVATE_HTTP_RESPONSE"), false);
        return true;
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("真实 loopback HTTP: 500 响应重试 3 次后失败", { timeout: 10000 }, async (t) => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    res.writeHead(500, {
      "content-type": "application/json",
      "retry-after-ms": "1",
    });
    res.end(JSON.stringify({ error: { message: "temporary error" } }));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const provider = new OpenAiCommandProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: "",
    model: "offline-test",
  });
  await assert.rejects(provider.generateCommands(testRequest()));
  assert.equal(requests, 3);
});
