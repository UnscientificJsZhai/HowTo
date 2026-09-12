import type { GenerateCommandsRequest } from "../../../src/ai/types.js";

const RESPONSE_TEXT = "howto boundary response";
const envelopeMode = process.env.HOWTO_TEST_GEMINI_ENVELOPE;
const validCandidate = {
  title: "List files",
  command: "ls",
  description: "List files",
  placeholders: [],
};
const commandJson = JSON.stringify({ commands: [validCandidate] });
const fakeSecret = "HOWTO_FAKE_ENVELOPE_SECRET";
let getterReads = 0;
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
      isOpenAi ? { choices: [{ message: { content: RESPONSE_TEXT } }] } : geminiEnvelope(),
    ),
  );
};

const { loadConfig } = await import("../../../src/config.js");
const { createCommandProvider } = await import("../../../src/ai/index.js");
const config = loadConfig({ print: false }, process.env);
const provider = createCommandProvider(config);
if (envelopeMode === "throwing-getter") {
  const response = { candidates: [{ content: { parts: [{ text: commandJson }] } }] };
  Object.defineProperty(response, "text", {
    get() {
      getterReads += 1;
      throw new Error(fakeSecret);
    },
  });
  Reflect.set(provider, "client", { models: { generateContent: () => Promise.resolve(response) } });
}
const request: GenerateCommandsRequest = {
  question: "list files",
  arguments: [],
  structuredOutput: true,
  outputContract: "contract",
  safetyConstraints: "safety",
  systemPrompt: "system prompt",
  userPrompt: "user prompt",
};
if (envelopeMode === undefined) {
  const result = await provider.generateCommands(request);
  // 只报告假凭据是否原样匹配，不把 header 或 key 写进输出。
  process.stdout.write(
    `${JSON.stringify({ requests, responseMatches: result.rawText === RESPONSE_TEXT })}\n`,
  );
} else {
  let responseMatches = false;
  try {
    const { generateValidatedCommandCandidates } =
      await import("../../../src/validation/generated-commands.js");
    const candidates = await generateValidatedCommandCandidates(provider, request);
    responseMatches = JSON.stringify(candidates) === JSON.stringify([validCandidate]);
  } catch (error) {
    const { toAppError } = await import("../../../src/errors.js");
    const appError = toAppError(error);
    process.stderr.write(`${appError.message}\n`);
    process.exitCode = appError.exitCode;
  }
  process.stdout.write(`${JSON.stringify({ requests, responseMatches, getterReads })}\n`);
}

function geminiEnvelope(): unknown {
  if (envelopeMode === undefined)
    return { candidates: [{ content: { parts: [{ text: RESPONSE_TEXT }] } }] };
  const marker = { [`\u001b[2Jenvelope_probe_${fakeSecret}`]: true };
  if (envelopeMode === "mixed") {
    const midpoint = Math.floor(commandJson.length / 2);
    return {
      candidates: [
        {
          content: {
            parts: [
              { text: commandJson.slice(0, midpoint), ...marker },
              { inlineData: { mimeType: "text/plain", data: "ignored" } },
              { thought: true, text: fakeSecret, thoughtSignature: fakeSecret },
              { thought: false, text: commandJson.slice(midpoint), thoughtSignature: fakeSecret },
            ],
          },
        },
        { content: { parts: [{ text: fakeSecret }] } },
      ],
    };
  }
  const parts: Record<string, unknown>[] =
    envelopeMode === "bad-text"
      ? [{ text: commandJson }, { text: 7, ...marker }]
      : envelopeMode === "bad-thought"
        ? [{ text: commandJson, thought: "true", ...marker }]
        : envelopeMode === "thought-only"
          ? [{ thought: true, text: fakeSecret, ...marker }]
          : envelopeMode === "blank"
            ? [{ text: " \n " }]
            : [{ text: `not JSON ${fakeSecret}`, ...marker }];
  return { candidates: [{ content: { parts } }] };
}
