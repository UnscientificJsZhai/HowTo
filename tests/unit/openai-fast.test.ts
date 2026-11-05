import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import OpenAI from "openai";

import { parseCliArgs, CliParseError } from "../../src/cli.js";
import { loadConfig, ConfigError } from "../../src/config.js";
import { readUserConfigFile, writeUserConfigFile } from "../../src/config-file.js";
import { OpenAiCommandProvider, buildOpenAiClientOptions } from "../../src/ai/openai.js";
import { AiProviderError } from "../../src/ai/errors.js";
import type { GenerateCommandsRequest } from "../../src/ai/types.js";
import { validateAndPersistInitializationConfig } from "../../src/init/index.js";

const wire = (body: unknown, init?: ResponseInit): Promise<Response> =>
  Promise.resolve(Response.json(body, init));

const options = { print: false, aiProvider: "openai" };
const request: GenerateCommandsRequest = {
  question: "list files",
  structuredOutput: true,
  outputContract: "contract",
  safetyConstraints: "safety",
  systemPrompt: "system",
  userPrompt: "user",
};

test("OpenAI Fast defaults off and resolves CLI > env > file independently of ChatGPT", () => {
  assert.equal(loadConfig(options, {}).openai.fast, false);
  assert.equal(loadConfig(options, {}, { openaiFast: true }).openai.fast, true);
  assert.equal(
    loadConfig(options, { HOWTO_OPENAI_FAST: "false" }, { openaiFast: true }).openai.fast,
    false,
  );
  for (const args of [["--openai-fast=true"], ["--openai-fast", "true"]]) {
    const parsed = parseCliArgs([...args, "--ai-provider", "openai", "list files"]);
    const config = loadConfig(parsed.options, {
      HOWTO_OPENAI_FAST: "false",
      HOWTO_CHATGPT_FAST: "false",
    });
    assert.equal(config.openai.fast, true);
    assert.equal(config.chatgpt.fast, false);
  }
  assert.equal(
    loadConfig({ ...options, openaiFast: "false" }, { HOWTO_OPENAI_FAST: "true" }).openai.fast,
    false,
  );
  assert.throws(() => parseCliArgs(["--openai-fast"]), CliParseError);
  for (const value of ["", "yes", "TRUE", "secret-invalid"]) {
    assert.throws(() => loadConfig({ ...options, openaiFast: value }, {}), ConfigError);
    assert.throws(() => loadConfig(options, { HOWTO_OPENAI_FAST: value }), ConfigError);
    assert.throws(() => loadConfig(options, {}, { openaiFast: value }), ConfigError);
  }
});

test("OpenAI Fast persists boolean/string values and resets when initializing another OpenAI endpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "howto-openai-fast-"));
  const path = join(home, ".howto", "config.json");
  try {
    for (const value of [true, false, "true", "false"]) {
      await writeUserConfigFile({ openaiFast: value }, path);
      assert.equal((await readUserConfigFile(path)).openaiFast, value);
    }
    await writeUserConfigFile({ openaiFast: true, chatgptFast: false }, path);
    const config = await validateAndPersistInitializationConfig(
      {
        provider: "openai",
        apiKey: "",
        model: "local",
        openaiBaseUrl: "http://localhost:11434/v1",
      },
      { print: false },
      { HOME: home },
    );
    assert.equal(config.openai.fast, false);
    assert.equal((await readUserConfigFile(path)).chatgptFast, false);
    assert.equal((await readUserConfigFile(path)).openaiFast, undefined);
    await writeUserConfigFile({ openaiFast: 1 } as never, path);
    await assert.rejects(readUserConfigFile(path), ConfigError);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

for (const baseUrl of [undefined, "http://localhost:11434/v1", "https://compatible.example/v1"])
  for (const fast of [undefined, false, true])
    for (const structuredOutput of [false, true]) {
      test(`OpenAI wire request: endpoint=${baseUrl}, fast=${fast}, structured=${structuredOutput}`, async () => {
        const config = {
          apiKey: baseUrl?.startsWith("http:") ? "" : "test-key",
          model: "test-model",
          baseUrl,
          fast,
        };
        const bodies: Record<string, unknown>[] = [];
        const client = new OpenAI({
          ...buildOpenAiClientOptions(config),
          fetch: (_url, init) => {
            const body = JSON.parse(init?.body as string) as Record<string, unknown>;
            bodies.push(body);
            if (!fast && "service_tier" in body)
              return wire({ error: { message: "Unknown field" } }, { status: 400 });
            return wire({
              choices: [{ message: { role: "assistant", content: "result" } }],
            });
          },
        });
        const provider = new OpenAiCommandProvider(config, { client });
        assert.deepEqual(await provider.generateCommands({ ...request, structuredOutput }), {
          rawText: "result",
        });
        await provider.generateCommands(
          { ...request, structuredOutput },
          new AbortController().signal,
        );
        const session = provider.createUsageSession({ ...request, structuredOutput });
        await session.next([], { toolsEnabled: true });
        await session.next([], { toolsEnabled: false });
        assert.equal(bodies.length, 4);
        for (const body of bodies) {
          assert.equal(Object.hasOwn(body, "service_tier"), fast === true);
          assert.equal(body.service_tier, fast ? "priority" : undefined);
          assert.equal(body.model, "test-model");
        }
      });
    }

for (const status of [400, 401, 403, 422, 429, 500])
  for (const usage of [false, true]) {
    test(`Fast failure ${status}, usage=${usage}: no downgrade or secret leakage`, async () => {
      let calls = 0;
      const client = new OpenAI({
        apiKey: "fake-secret",
        maxRetries: 0,
        fetch: (_url, init) => {
          calls++;
          assert.equal(
            (JSON.parse(init?.body as string) as { service_tier?: string }).service_tier,
            "priority",
          );
          return wire(
            {
              error: {
                code: "unsupported_parameter",
                param: "service_tier",
                message: "fake-secret unsupported service_tier",
              },
            },
            { status },
          );
        },
      });
      const provider = new OpenAiCommandProvider(
        { apiKey: "fake-secret", model: "test-model", fast: true },
        { client },
      );
      await assert.rejects(
        usage
          ? provider.createUsageSession(request).next([], { toolsEnabled: true })
          : provider.generateCommands(request),
        (error: unknown) =>
          error instanceof AiProviderError &&
          error.message === "AI provider request failed (provider: openai, model: test-model)",
      );
      assert.equal(calls, 1);
    });
  }

test("Fast remains enabled after a usage tool reply", async () => {
  let calls = 0;
  const client = new OpenAI({
    apiKey: "test-key",
    fetch: (_url, init) => {
      const body = JSON.parse(init?.body as string) as {
        service_tier?: string;
        messages: { role: string; tool_call_id?: string }[];
      };
      assert.equal(body.service_tier, "priority");
      calls++;
      if (calls === 1) {
        return wire({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } },
                ],
              },
            },
          ],
        });
      }
      assert.equal(body.messages.at(-1)?.role, "tool");
      assert.equal(body.messages.at(-1)?.tool_call_id, "call-1");
      return wire({ choices: [{ message: { role: "assistant", content: "done" } }] });
    },
  });
  const session = new OpenAiCommandProvider(
    { apiKey: "test-key", model: "test-model", fast: true },
    { client },
  ).createUsageSession(request);
  assert.equal((await session.next([], { toolsEnabled: true })).kind, "tool_calls");
  assert.deepEqual(
    await session.next(
      [
        {
          callId: "call-1",
          result: {
            requested: {},
            actualCommand: null,
            status: "success",
            stdout: "help",
            stderr: "",
            exitCode: 0,
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            credentialsRedacted: false,
          },
        },
      ],
      { toolsEnabled: false },
    ),
    { kind: "final", rawText: "done" },
  );
  assert.equal(calls, 2);
});
