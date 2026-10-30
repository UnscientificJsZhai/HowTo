import assert from "node:assert/strict";
import test from "node:test";
import { ChatGptCommandProvider } from "../../src/ai/chatgpt.js";
import { parseChatGptModels } from "../../src/ai/chatgpt-models.js";
import { loadConfig } from "../../src/config.js";
import { parseCliArgs } from "../../src/cli.js";
import { testRequest } from "../helpers/interactive-session.js";

const model = "test-model";
const credentials = { accountId: "fake-account", accessToken: "fake-token" };
const catalog = (tiers: unknown = [{ id: "priority" }]) => ({
  models: [{ slug: model, display_name: "Test", visibility: "list", service_tiers: tiers }],
});
const message = {
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: '{"commands":[]}' }],
};
const stream = (tier: unknown, output: unknown[] = [message]) =>
  new Response(
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output, service_tier: tier } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

test("Fast settings default on, CLI > environment > file, invalid values rejected", () => {
  const options = parseCliArgs([
    "--ai-provider",
    "chatgpt",
    "--chatgpt-model",
    model,
    "--chatgpt-fast=false",
    "--chatgpt-timings=true",
    "test",
  ]).options;
  assert.equal(
    loadConfig(options, { HOWTO_CHATGPT_FAST: "true" }, { chatgptFast: true }).chatgpt.fast,
    false,
  );
  assert.equal(loadConfig(options, {}).chatgpt.timings, true);
  assert.equal(
    loadConfig({ print: true, aiProvider: "chatgpt", chatgptModel: model }, {}).chatgpt.fast,
    true,
  );
  assert.throws(() => loadConfig({ ...options, chatgptFast: "yes" }, {}), /expected true or false/);
});

test("Only validated modern tier metadata is retained, missing/malformed is unknown", () => {
  assert.deepEqual(parseChatGptModels(catalog())[0].serviceTiers, ["priority"]);
  assert.equal(parseChatGptModels(catalog(null))[0].serviceTiers, undefined);
});

test("Usage conversation carries tier on every turn, no catalog request, actual downgrade retained", async () => {
  let gets = 0,
    posts = 0;
  const provider = new ChatGptCommandProvider(
    { model, fast: true },
    {
      getAccessToken: () => Promise.resolve(credentials),
      fetch: (_url, init) => {
        if (init?.method === "GET") {
          gets++;
          return Promise.resolve(Response.json(catalog()));
        }
        posts++;
        assert.equal(typeof init?.body, "string");
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        assert.equal(body.service_tier, "priority");
        return Promise.resolve(
          stream(
            "default",
            posts === 1
              ? [
                  {
                    type: "function_call",
                    call_id: "call1",
                    name: "lookup_command_usage",
                    arguments: '{"command":"ls","args":["--help"]}',
                    status: "completed",
                  },
                ]
              : [message],
          ),
        );
      },
    },
  );
  const session = provider.createUsageSession(testRequest());
  const first = await session.next([], { toolsEnabled: true });
  assert.equal(first.kind, "tool_calls");
  assert.match(provider.getFeedback()!, /actual tier: standard/);
  const second = await session.next(
    [
      {
        callId: "call1",
        result: {
          requested: { args: ["--help"] },
          actualCommand: null,
          status: "rejected",
          stdout: "",
          stderr: "",
          exitCode: null,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          credentialsRedacted: false,
        },
      },
    ],
    { toolsEnabled: false },
  );
  assert.equal(second.kind, "final");
  assert.equal(gets, 0);
  assert.equal(posts, 2);
});

test("Runtime command examples parse with exact boolean values and preserve explicit false", () => {
  const base = ["--ai-provider", "chatgpt", "--chatgpt-model", "YOUR_MODEL_SLUG"];
  for (const args of [
    ["list files"],
    ["--chatgpt-fast", "true", "list files"],
    ["--chatgpt-fast=false", "list files"],
    ["--chatgpt-timings", "true", "list files"],
    ["--chatgpt-timings=false", "list files"],
    ["--print", "--chatgpt-fast", "false", "list files"],
    ["use", "git", "show changed files"],
    [
      "--chatgpt-account",
      "ACCOUNT_ID",
      "--chatgpt-fast",
      "false",
      "use",
      "git",
      "show changed files",
    ],
  ]) {
    const parsed = parseCliArgs([...base, ...args]);
    const config = loadConfig(parsed.options, {});
    assert.equal(config.chatgpt.fast, parsed.options.chatgptFast !== "false");
    assert.equal(config.chatgpt.timings, parsed.options.chatgptTimings === "true");
  }
  const options = parseCliArgs([...base, "test"]).options;
  assert.equal(loadConfig(options, {}, { chatgptFast: false }).chatgpt.fast, false);
  assert.equal(
    loadConfig(options, { HOWTO_CHATGPT_FAST: "false" }, { chatgptFast: true }).chatgpt.fast,
    false,
  );
  assert.equal(
    loadConfig({ ...options, chatgptFast: "true" }, { HOWTO_CHATGPT_FAST: "false" }).chatgpt.fast,
    true,
  );
  for (const value of ["TRUE", "False", "1", "0", "yes", "", " true "]) {
    assert.throws(
      () => loadConfig({ ...options, chatgptFast: value }, {}),
      /expected true or false/,
    );
    assert.throws(
      () => loadConfig({ ...options, chatgptTimings: value }, {}),
      /expected true or false/,
    );
  }
  for (const flag of ["--chatgpt-fast", "--chatgpt-timings"]) {
    assert.throws(() => parseCliArgs([...base, "test", flag]), /missing value/);
  }
  assert.equal(
    parseCliArgs(["--chatgpt-models", "--chatgpt-account", "ACCOUNT_ID"]).options.chatgptAction,
    "models",
  );
  assert.throws(
    () => parseCliArgs(["--chatgpt-models", "--chatgpt-fast", "false"]),
    /ChatGPT actions accept/,
  );
});

for (const code of ["model_not_found", "unsupported_service_tier"]) {
  for (const streaming of [false, true]) {
    test(`Explicit ${code} (${streaming ? "SSE" : "HTTP"}) refreshes once without inference retry`, async () => {
      const methods: string[] = [];
      const provider = new ChatGptCommandProvider(
        { model },
        {
          getAccessToken: () => Promise.resolve(credentials),
          fetch: (_url, init) => {
            methods.push(init?.method ?? "");
            if (init?.method === "GET") return Promise.resolve(Response.json(catalog()));
            return Promise.resolve(
              streaming
                ? new Response(
                    `data: ${JSON.stringify({ type: "response.failed", response: { error: { code } } })}\n\n`,
                    { headers: { "content-type": "text/event-stream" } },
                  )
                : Response.json({ error: { code } }, { status: 400 }),
            );
          },
        },
      );
      await assert.rejects(provider.generateCommands(testRequest()), /Model list refreshed/);
      assert.deepEqual(methods, ["POST", "GET"]);
    });
  }
}

test("Discovery failure preserves original model error, no retry or model substitution", async () => {
  for (const failure of ["network", "auth", "timeout"]) {
    const methods: string[] = [];
    const provider = new ChatGptCommandProvider(
      { model },
      {
        timeoutMilliseconds: 25,
        getAccessToken: () => Promise.resolve(credentials),
        fetch: (_url, init) => {
          methods.push(init?.method ?? "");
          if (init?.method === "POST")
            return Promise.resolve(
              Response.json({ error: { code: "model_not_found" } }, { status: 404 }),
            );
          if (failure === "network") throw new Error("private-network-detail");
          if (failure === "timeout") return new Promise(() => {});
          return Promise.resolve(new Response("private-auth-detail", { status: 401 }));
        },
      },
    );
    await assert.rejects(provider.generateCommands(testRequest()), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /selected ChatGPT model is unavailable/);
      assert.doesNotMatch(error.message, /private-|refreshed/);
      return true;
    });
    assert.deepEqual(methods, ["POST", "GET"]);
  }
});

for (const status of [400, 401, 403, 429, 500]) {
  test(`Generic HTTP ${status} does not refresh model discovery`, async () => {
    const methods: string[] = [];
    const provider = new ChatGptCommandProvider(
      { model },
      {
        getAccessToken: () => Promise.resolve(credentials),
        fetch: (_url, init) => {
          methods.push(init?.method ?? "");
          return Promise.resolve(new Response("private", { status }));
        },
      },
    );
    await assert.rejects(provider.generateCommands(testRequest()));
    assert.deepEqual(methods, ["POST"]);
  });
}

test("Separate CLI-style providers use saved model without any catalog request", async () => {
  let posts = 0;
  for (let i = 0; i < 6; i++) {
    const provider = new ChatGptCommandProvider(
      { model },
      {
        getAccessToken: () => Promise.resolve(credentials),
        fetch: (_url, init) => {
          assert.equal(init?.method, "POST");
          posts++;
          assert.equal(typeof init.body, "string");
          assert.equal((JSON.parse(init.body as string) as { model: string }).model, model);
          return Promise.resolve(stream("priority"));
        },
      },
    );
    await provider.generateCommands(testRequest());
  }
  assert.equal(posts, 6);
});

for (const fast of [false, true])
  for (const tier of ["priority", "fast", "default", undefined, "private-untrusted"]) {
    test(`Direct request Fast=${fast}, actual=${tier ?? "missing"}, no discovery`, async () => {
      const provider = new ChatGptCommandProvider(
        { model, fast, timings: true },
        {
          getAccessToken: () => Promise.resolve(credentials),
          fetch: (_url, init) => {
            assert.equal(init?.method, "POST");
            assert.equal(typeof init.body, "string");
            assert.equal(
              (JSON.parse(init.body as string) as { service_tier: string }).service_tier,
              fast ? "priority" : "default",
            );
            return Promise.resolve(stream(tier));
          },
        },
      );
      await provider.generateCommands(testRequest());
      assert.match(provider.getFeedback()!, /catalog=not-requested/);
      assert.match(
        provider.getFeedback()!,
        new RegExp(
          `actual tier: ${tier === "priority" || tier === "fast" ? "Fast" : tier === "default" ? "standard" : "unconfirmed"}`,
        ),
      );
      assert.doesNotMatch(provider.getFeedback()!, /private-untrusted|fake-token/);
    });
  }

test("Usage model error refreshes discovery but never advances/retries inference", async () => {
  const methods: string[] = [];
  const provider = new ChatGptCommandProvider(
    { model },
    {
      getAccessToken: () => Promise.resolve(credentials),
      fetch: (_url, init) => {
        methods.push(init?.method ?? "");
        return Promise.resolve(
          init?.method === "GET"
            ? Response.json({ models: [] })
            : Response.json({ error: { code: "model_not_found" } }, { status: 404 }),
        );
      },
    },
  );
  await assert.rejects(
    provider.createUsageSession(testRequest()).next([], { toolsEnabled: true }),
    /selected model is not listed/,
  );
  assert.deepEqual(methods, ["POST", "GET"]);
});
