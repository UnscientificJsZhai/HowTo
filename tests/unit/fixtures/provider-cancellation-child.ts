import { performance } from "node:perf_hooks";

const mode = process.argv[2];
const startedAt = performance.now();
const originalFetch = globalThis.fetch;
let requestCount = 0;
let abortCount = 0;

// 只允许 Ink 的内嵌 WASM 使用本地 data: URL；所有 AI 请求都由替身处理。
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).protocol === "data:") return originalFetch(input, init);
  if (request.url !== "https://howto-provider-test.invalid/v1/chat/completions") {
    return Promise.reject(new Error("unexpected external fetch blocked"));
  }
  requestCount++;

  if (mode === "cancel") {
    process.stderr.write("HOWTO_PROVIDER_PENDING\n");
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => {
        abortCount++;
        reject(new DOMException("HOWTO_FAKE_CANCEL_SECRET", "AbortError"));
      };
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  if (mode === "rate-limit" || requestCount === 1) {
    return Promise.resolve(
      Response.json(
        { error: { message: "HOWTO_FAKE_RETRY_SECRET" } },
        {
          status: 429,
          // 交互回归的超时小于该等待，旧实现会被判定为无法自然退出。
          headers: { "retry-after-ms": mode === "rate-limit" ? "10000" : "1" },
        },
      ),
    );
  }

  return Promise.resolve(
    Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              commands: [
                { title: "列出文件", command: "ls", description: "列出文件", placeholders: [] },
              ],
            }),
          },
        },
      ],
    }),
  );
};

const { run } = await import("../../../src/index.js");
const result = await run([
  ...(mode === "print-retry" ? ["--print"] : []),
  "--ai-provider",
  "openai",
  "--openai-api-key",
  "howto-fake-provider-key",
  "--openai-api-url",
  "https://howto-provider-test.invalid/v1",
  "--openai-model",
  "gpt-test",
  "列出文件",
]);
process.exitCode = result.exitCode;

function report(event: string) {
  process.stdout.write(
    `HOWTO_PROVIDER_RESULT:${JSON.stringify({
      event,
      exitCode: result.exitCode,
      requestCount,
      abortCount,
      elapsedMs: Math.round(performance.now() - startedAt),
    })}\n`,
  );
}

report("returned");
process.once("exit", () => report("exit"));
