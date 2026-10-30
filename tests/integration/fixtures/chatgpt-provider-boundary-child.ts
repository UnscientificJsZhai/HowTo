import {
  CHATGPT_TEST_CATALOG,
  CHATGPT_TEST_MODEL,
  CHATGPT_TEST_SECRET,
  CHATGPT_TEST_TEXT,
  CHATGPT_TEST_TOKEN,
  chatGptTestCompleted,
  chatGptTestFrame,
  chatGptSubscriptionTestCompleted,
} from "./chatgpt-test-data.js";

const mode = process.env.HOWTO_TEST_CHATGPT_MODE ?? "valid";
const requests: {
  url: string;
  method: string;
  credentialsMatch: boolean;
  headersIsolated: boolean;
}[] = [];

// 拦截发生在导入 Provider 之前；任何分支都不会调用原始 fetch 或真实凭证存储。
globalThis.fetch = (input, init) => {
  const request = new Request(input, init);
  requests.push({
    url: request.url,
    method: request.method,
    credentialsMatch: request.headers.get("authorization") === `Bearer ${CHATGPT_TEST_TOKEN}`,
    headersIsolated: [...request.headers.keys()].every((key) =>
      ["accept", "authorization", "content-type"].includes(key),
    ),
  });
  if (request.url === "https://api.openai.com/v1/models") {
    return Promise.resolve(Response.json(CHATGPT_TEST_CATALOG));
  }
  if (mode === "subscription-shape") {
    return Promise.resolve(
      new Response(new TextEncoder().encode(chatGptSubscriptionTestCompleted())),
    );
  }
  if (mode.startsWith("http-")) {
    const status = Number(mode.slice(5));
    return Promise.resolve(
      Response.json({ detail: `\u001b[2J${CHATGPT_TEST_SECRET}` }, { status }),
    );
  }
  if (mode === "stream-failed") {
    return Promise.resolve(
      sse(
        chatGptTestFrame({
          type: "response.failed",
          response: {
            status: "failed",
            error: {
              code: "subscription_sharing_usage_limit_exceeded",
              message: CHATGPT_TEST_SECRET,
            },
          },
        }),
      ),
    );
  }
  if (mode === "malformed") return Promise.resolve(sse(`data: ${CHATGPT_TEST_SECRET}\n\n`));
  if (mode === "incomplete")
    return Promise.resolve(
      sse(
        chatGptTestFrame({
          type: "response.output_text.delta",
          delta: CHATGPT_TEST_TEXT,
        }),
      ),
    );
  const prefix =
    mode === "unknown-thread" ? `event: thread.unknown\ndata: ${CHATGPT_TEST_SECRET}\n\n` : "";
  return Promise.resolve(
    sse(
      prefix +
        chatGptTestCompleted(mode === "invalid-json" ? CHATGPT_TEST_SECRET : CHATGPT_TEST_TEXT),
    ),
  );
};

const { ChatGptCommandProvider } = await import("../../../src/ai/chatgpt.js");
const { generateValidatedCommandCandidates } =
  await import("../../../src/validation/generated-commands.js");
const { toAppError } = await import("../../../src/errors.js");

try {
  const provider = new ChatGptCommandProvider(
    { fast: false, model: CHATGPT_TEST_MODEL },
    {
      getAccessToken: () => {
        if (mode === "auth-error") throw new Error(CHATGPT_TEST_SECRET);
        return Promise.resolve({ accessToken: CHATGPT_TEST_TOKEN, accountId: "test-account" });
      },
    },
  );
  const commands = await generateValidatedCommandCandidates(provider, {
    question: "list files",
    structuredOutput: true,
    outputContract: "contract",
    safetyConstraints: "safety",
    systemPrompt: "Generate JSON commands",
    userPrompt: "list files",
  });
  process.stdout.write(`${commands[0].command}\n`);
} catch (error) {
  const appError = toAppError(error);
  if (appError.message) process.stderr.write(`${appError.message}\n`);
  process.exitCode = appError.exitCode;
}
process.stdout.write(`${JSON.stringify({ requests, exitCode: process.exitCode ?? 0 })}\n`);

function sse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
