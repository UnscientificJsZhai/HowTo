import type { GenerateCommandsRequest } from "../../../src/ai/types.js";

const RESPONSE_TEXT = "howto boundary response";
const requests: { url: string; method: string; credentialsMatch: boolean }[] = [];

// 先拦截所有 fetch，再导入真实 SDK；替身从不调用原始 fetch，也不访问真实服务。
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  const isOpenAi = process.env.HOWTO_AI_PROVIDER === "openai";
  const apiKey = isOpenAi
    ? (process.env.HOWTO_OPENAI_API_KEY ?? "")
    : process.env.HOWTO_GEMINI_API_KEY;
  const credentialsMatch = isOpenAi
    ? request.headers.get("Authorization") === (apiKey?.trim() ? `Bearer ${apiKey}` : null)
    : request.headers.get("x-goog-api-key") === apiKey &&
      request.headers.get("Authorization") === null;
  requests.push({ url: request.url, method: request.method, credentialsMatch });

  return Promise.resolve(
    Response.json(
      isOpenAi
        ? { choices: [{ message: { content: RESPONSE_TEXT } }] }
        : { candidates: [{ content: { parts: [{ text: RESPONSE_TEXT }] } }] },
    ),
  );
};

const { loadConfig } = await import("../../../src/config.js");
const { createCommandProvider } = await import("../../../src/ai/index.js");
const config = loadConfig({ print: false }, process.env);
const provider = createCommandProvider(config);
const request: GenerateCommandsRequest = {
  question: "list files",
  arguments: [],
  structuredOutput: true,
  outputContract: "contract",
  safetyConstraints: "safety",
  systemPrompt: "system prompt",
  userPrompt: "user prompt",
};
const result = await provider.generateCommands(request);

// 只报告假凭据是否原样匹配，不把 header 或 key 写进输出。
process.stdout.write(
  `${JSON.stringify({ requests, responseMatches: result.rawText === RESPONSE_TEXT })}\n`,
);
