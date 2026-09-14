// 先截获网络请求，再加载真实 CLI；只有 Ink 的内嵌 WASM data URL 交给原 fetch。
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).protocol === "data:") return originalFetch(input, init);
  requests += 1;
  const command = { title: "测试", command: "ls", description: "测试", placeholders: [] };
  return Promise.resolve(
    Response.json({ choices: [{ message: { content: JSON.stringify({ commands: [command] }) } }] }),
  );
};

const { run } = await import("../../../src/index.js");
const result = await run([
  "--print",
  "--ai-provider",
  "openai",
  "--openai-api-key",
  "howto-fake-config-key",
  "--openai-model",
  "gpt-test",
  "list files",
]);
process.stdout.write(`${JSON.stringify({ requests, exitCode: result.exitCode })}\n`);
process.exitCode = result.exitCode;
