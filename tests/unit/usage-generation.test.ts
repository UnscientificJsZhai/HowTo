import assert from "node:assert/strict";
import test from "node:test";
import type { CommandProvider, GenerateCommandsRequest } from "../../src/ai/types.js";
import { UsageToolsUnsupportedError } from "../../src/ai/errors.js";
import { toAppError } from "../../src/errors.js";
import { buildCommandGenerationPrompt, createProviderPromptRequest } from "../../src/prompt.js";
import {
  generateWithUsageLookup,
  USAGE_CAPABILITY_FALLBACK_NOTICE,
} from "../../src/usage/generate.js";
import { createUsageLookupResult, type executeUsageLookup } from "../../src/usage/runner.js";
import type {
  UsageApprovalDecision,
  UsageApprovalRequest,
  UsageGenerationInteraction,
  UsageGenerationSession,
  UsageSessionTurn,
  UsageToolCall,
  UsageToolReply,
} from "../../src/usage/types.js";
import { AiResponseValidationError } from "../../src/validation/ai-response.js";
import { parseAndValidateUsageResponse } from "../../src/validation/usage-response.js";

const candidate = {
  title: "查询状态",
  command: "git status",
  description: "查看工作区",
  dangerous: false,
  dangerReason: "",
  placeholders: [],
};
const final: UsageSessionTurn = {
  kind: "final",
  rawText: JSON.stringify({ commands: [candidate], failureReason: "" }),
};

function request(structuredOutput = true): GenerateCommandsRequest {
  const prompt = createProviderPromptRequest({
    question: "查看状态",
    useCommand: "git",
    structuredOutput,
  });
  return { ...prompt, ...buildCommandGenerationPrompt(prompt) };
}

function call(args: string[], id = "call-1"): UsageToolCall {
  return {
    id,
    name: "lookup_command_usage",
    arguments: { args, purpose: "查询用法", dangerous: false, dangerReason: "" },
  };
}

function setup(turns: Array<UsageSessionTurn | Error>, structuredOutput = true) {
  const nextCalls: Array<{ replies: UsageToolReply[]; toolsEnabled: boolean }> = [];
  const approvals: string[][] = [];
  const executions: Array<Parameters<typeof executeUsageLookup>[0]> = [];
  const notices: string[] = [];
  let sessionRequest: GenerateCommandsRequest | undefined;
  let plainRequests = 0;
  let policy: "execute" | "print" = "execute";
  const listeners = new Set<() => void>();
  const session: UsageGenerationSession = {
    next(replies, options) {
      nextCalls.push({ replies, toolsEnabled: options.toolsEnabled });
      const turn = turns.shift();
      if (turn === undefined) throw new Error("unexpected generation round");
      return turn instanceof Error ? Promise.reject(turn) : Promise.resolve(turn);
    },
  };
  const provider: CommandProvider = {
    generateCommands() {
      plainRequests++;
      return Promise.resolve({ rawText: JSON.stringify({ commands: [candidate] }) });
    },
    createUsageSession(value) {
      sessionRequest = value;
      return session;
    },
  };
  const interaction: UsageGenerationInteraction = {
    approve(value: UsageApprovalRequest): Promise<UsageApprovalDecision> {
      approvals.push(value.lookup.args);
      return Promise.resolve<UsageApprovalDecision>({ kind: "approve", args: value.lookup.args });
    },
    getExecutionPolicy: () => policy,
    subscribeExecutionPolicy(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onCapabilityFallback(message) {
      notices.push(message);
    },
  };
  const controller = new AbortController();
  const dependencies = {
    resolveExecutable: () => "/usr/bin/git",
    executeLookup: ((options) => {
      executions.push(options);
      return Promise.resolve({
        ...createUsageLookupResult(options.requested, "success"),
        actualCommand: { executable: options.executable, args: options.args },
        stdout: "usage help",
        exitCode: 0,
      });
    }) satisfies typeof executeUsageLookup,
  };
  return {
    provider,
    interaction,
    controller,
    dependencies,
    nextCalls,
    approvals,
    executions,
    notices,
    session,
    get sessionRequest() {
      return sessionRequest;
    },
    get plainRequests() {
      return plainRequests;
    },
    revoke() {
      policy = "print";
      for (const listener of listeners) listener();
    },
    run: () =>
      generateWithUsageLookup(
        provider,
        request(structuredOutput),
        interaction,
        controller.signal,
        dependencies,
      ),
  };
}

for (const structuredOutput of [false, true]) {
  test(`已掌握用法直接生成，无审批或执行 (${structuredOutput})`, async () => {
    const flow = setup([final], structuredOutput);
    assert.deepEqual(await flow.run(), [candidate]);
    assert.equal(flow.approvals.length, 0);
    assert.equal(flow.executions.length, 0);
    assert.equal(flow.nextCalls.length, 1);
    assert.equal(flow.sessionRequest?.structuredOutput, structuredOutput);
    assert.match(flow.sessionRequest?.systemPrompt ?? "", /UNTRUSTED DATA/);
    assert.match(flow.sessionRequest?.outputContract ?? "", /failureReason/);
    assert.doesNotMatch(
      flow.sessionRequest?.outputContract ?? "",
      /The commands array must contain 1 to 3 items/,
    );
  });
}

test("多层查询逐轮审批并关联调用结果", async () => {
  const flow = setup([
    { kind: "tool_calls", calls: [call(["--help"], "a")] },
    { kind: "tool_calls", calls: [call(["nested", "detail", "--help"], "b")] },
    final,
  ]);
  assert.deepEqual(await flow.run(), [candidate]);
  assert.equal(flow.executions.length, 2);
  assert.deepEqual(flow.approvals, [["--help"], ["nested", "detail", "--help"]]);
  assert.equal(flow.nextCalls[1].replies[0].callId, "a");
  assert.deepEqual(flow.nextCalls[2].replies[0].result.actualCommand, {
    executable: "/usr/bin/git",
    args: ["nested", "detail", "--help"],
  });
});

test("未指定 useCommand 时保留单次普通生成，不暴露查询工具", async () => {
  const flow = setup([]);
  await generateWithUsageLookup(
    flow.provider,
    { ...request(), useCommand: undefined },
    flow.interaction,
    flow.controller.signal,
    flow.dependencies,
  );
  assert.equal(flow.plainRequests, 1);
  assert.equal(flow.sessionRequest, undefined);
});

test("拒绝结果回传，重复被拒查询不再审批，模型仍可换查询", async () => {
  const flow = setup([
    { kind: "tool_calls", calls: [call(["--help"], "a")] },
    { kind: "tool_calls", calls: [call(["--help"], "b"), call(["help"], "c")] },
    final,
  ]);
  let approvals = 0;
  flow.interaction.approve = (value) =>
    Promise.resolve(
      ++approvals === 1 ? { kind: "reject" } : { kind: "approve", args: value.lookup.args },
    );
  await flow.run();
  assert.equal(approvals, 2);
  assert.equal(flow.executions.length, 1);
  assert.equal(flow.nextCalls[1].replies[0].result.status, "rejected");
  assert.equal(flow.nextCalls[2].replies[0].result.status, "rejected");
  assert.equal(flow.nextCalls[2].replies[0].result.actualCommand, null);
  assert.equal(flow.nextCalls[2].replies[1].result.status, "success");
});

test("编辑后的实际参数执行并回传，原请求与实际命令分别保留", async () => {
  const original = call(["--help"]);
  const flow = setup([
    { kind: "tool_calls", calls: [original] },
    { kind: "tool_calls", calls: [call(["--help"], "again")] },
    final,
  ]);
  flow.interaction.approve = (): Promise<UsageApprovalDecision> =>
    Promise.resolve<UsageApprovalDecision>({ kind: "approve", args: ["help", "log"] });
  await flow.run();
  assert.deepEqual(flow.executions[0].args, ["help", "log"]);
  assert.deepEqual(flow.nextCalls[1].replies[0].result.requested, original.arguments);
  assert.deepEqual(flow.nextCalls[1].replies[0].result.actualCommand?.args, ["help", "log"]);
  assert.equal(flow.executions.length, 1);
});

test("六次预算包括重复和拒绝；额外调用不审批并在最后一轮移除工具", async () => {
  const flow = setup([
    {
      kind: "tool_calls",
      calls: Array.from({ length: 8 }, (_, index) => call(["--help"], `c${index}`)),
    },
    final,
  ]);
  await flow.run();
  assert.equal(flow.executions.length, 1);
  assert.equal(flow.approvals.length, 1);
  assert.equal(flow.nextCalls[1].toolsEnabled, false);
  assert.deepEqual(
    flow.nextCalls[1].replies.map((reply) => reply.result.status),
    [
      "success",
      "success",
      "success",
      "success",
      "success",
      "success",
      "budget_exhausted",
      "budget_exhausted",
    ],
  );
});

test("非法工具及参数均返回明确状态且从不审批执行", async () => {
  const flow = setup([
    {
      kind: "tool_calls",
      calls: [
        { ...call([]), name: "run_shell" },
        { ...call([]), arguments: { args: "--help" } },
        { ...call([]), arguments: { ...(call([]).arguments as object), executable: "other" } },
      ],
    },
    final,
  ]);
  await flow.run();
  assert.equal(flow.approvals.length, 0);
  assert.equal(flow.executions.length, 0);
  assert.ok(
    flow.nextCalls[1].replies.every(
      ({ result }) => result.status === "invalid_arguments" && result.actualCommand === null,
    ),
  );
});

test("本机不存在程序返回 not_found，仍允许模型生成或明确失败", async () => {
  const flow = setup([{ kind: "tool_calls", calls: [call(["--help"])] }, final]);
  await generateWithUsageLookup(
    flow.provider,
    request(),
    flow.interaction,
    flow.controller.signal,
    { ...flow.dependencies, resolveExecutable: () => null },
  );
  assert.equal(flow.approvals.length, 0);
  assert.equal(flow.executions.length, 0);
  assert.equal(flow.nextCalls[1].replies[0].result.status, "not_found");
});

test("审批期间撤销权限使当前查询不执行，下一轮关闭工具", async () => {
  const flow = setup([{ kind: "tool_calls", calls: [call(["--help"])] }, final]);
  flow.interaction.approve = (value: UsageApprovalRequest): Promise<UsageApprovalDecision> => {
    flow.revoke();
    return Promise.resolve<UsageApprovalDecision>({ kind: "approve", args: value.lookup.args });
  };
  await flow.run();
  assert.equal(flow.executions.length, 0);
  assert.equal(flow.nextCalls[1].replies[0].result.status, "permission_revoked");
  assert.equal(flow.nextCalls[1].toolsEnabled, false);
});

test("无执行权限的 use 仍保留明确失败契约", async () => {
  const flow = setup([
    {
      kind: "final",
      rawText: JSON.stringify({ commands: [], failureReason: "缺少本机用法，无法可靠生成" }),
    },
  ]);
  flow.revoke();
  await assert.rejects(
    flow.run,
    (error: unknown) =>
      toAppError(error).exitCode === 2 && toAppError(error).message.includes("无法可靠生成"),
  );
  assert.equal(flow.nextCalls[0].toolsEnabled, false);
});

test("能力错误只降级一次，继续交付已有结果且保留失败能力", async () => {
  const flow = setup([
    { kind: "tool_calls", calls: [call(["--help"])] },
    new UsageToolsUnsupportedError("openai", "test"),
    {
      kind: "final",
      rawText: JSON.stringify({ commands: [], failureReason: "工具不受支持，证据不足" }),
    },
  ]);
  await assert.rejects(flow.run, (error: unknown) => toAppError(error).exitCode === 2);
  assert.deepEqual(flow.notices, [USAGE_CAPABILITY_FALLBACK_NOTICE]);
  assert.equal(flow.nextCalls[2].toolsEnabled, false);
  assert.deepEqual(flow.nextCalls[2].replies, flow.nextCalls[1].replies);
});

test("一般请求错误不降级或重试", async () => {
  const error = new Error("request failed");
  const flow = setup([error]);
  await assert.rejects(flow.run, (actual) => actual === error);
  assert.equal(flow.notices.length, 0);
  assert.equal(flow.nextCalls.length, 1);
});

test("关闭工具后仍返回调用时明确失败，不无限循环", async () => {
  const flow = setup([
    new UsageToolsUnsupportedError("openai", "test"),
    { kind: "tool_calls", calls: [call([])] },
  ]);
  await assert.rejects(flow.run, (error: unknown) => toAppError(error).exitCode === 2);
  assert.equal(flow.nextCalls.length, 2);
  assert.equal(flow.executions.length, 0);
});

test("取消整个任务返回 130，审批结果不能越过取消启动进程", async () => {
  const flow = setup([{ kind: "tool_calls", calls: [call(["--help"])] }]);
  flow.interaction.approve = (value: UsageApprovalRequest): Promise<UsageApprovalDecision> => {
    flow.controller.abort();
    return Promise.resolve<UsageApprovalDecision>({ kind: "approve", args: value.lookup.args });
  };
  await assert.rejects(flow.run, (error: unknown) => toAppError(error).exitCode === 130);
  assert.equal(flow.executions.length, 0);
});

test("已知凭据在工具参数和输出中脱敏，明确失败也不能回显凭据", async () => {
  const secret = "fixture-private-credential";
  const flow = setup([
    { kind: "tool_calls", calls: [call([secret])] },
    {
      kind: "final",
      rawText: JSON.stringify({ commands: [], failureReason: `不能使用 ${secret}` }),
    },
  ]);
  flow.session.getKnownCredentials = () => [secret];
  await assert.rejects(
    flow.run,
    (error: unknown) =>
      !toAppError(error).message.includes(secret) && toAppError(error).exitCode === 2,
  );
  assert.equal(JSON.stringify(flow.nextCalls[1].replies).includes(secret), false);
  assert.equal(flow.nextCalls[1].replies[0].result.credentialsRedacted, true);
});

test("审批和运行预览使用合并凭据，批准后重新读取会话令牌", async () => {
  const flow = setup([{ kind: "tool_calls", calls: [call(["--help"])] }, final]);
  const initial = ["FAKE-access", "FAKE-refresh", "FAKE-id"];
  const rotated = "FAKE-rotated-token";
  let credentials = initial;
  flow.interaction.knownCredentials = ["FAKE-api-key"];
  flow.session.getKnownCredentials = () => credentials;
  flow.interaction.approve = (approval: UsageApprovalRequest): Promise<UsageApprovalDecision> => {
    assert.deepEqual(approval.knownCredentials, ["FAKE-api-key", ...initial]);
    credentials = [...initial, rotated];
    return Promise.resolve<UsageApprovalDecision>({ kind: "approve", args: approval.lookup.args });
  };
  const running: Array<Parameters<NonNullable<UsageGenerationInteraction["onQueryRunning"]>>[0]> =
    [];
  flow.interaction.onQueryRunning = (command) => running.push(command);
  await flow.run();
  assert.deepEqual(running[0]?.knownCredentials, ["FAKE-api-key", ...initial, rotated]);
  assert.equal(running[1], null);
  assert.deepEqual(flow.executions[0].knownCredentials, ["FAKE-api-key", ...initial, rotated]);
});

test("扩展最终契约仍强校验危险标记、占位符与 use 工具", async () => {
  const cases = [
    { commands: [], failureReason: "" },
    { commands: [candidate], failureReason: "有候选不能有失败原因" },
    { commands: [candidate] },
    { commands: [], failureReason: "unsafe\u001b[2J" },
    { commands: [{ ...candidate, dangerous: undefined }], failureReason: "" },
    { commands: [{ ...candidate, command: "git {{missing}}" }], failureReason: "" },
  ];
  for (const value of cases)
    assert.throws(
      () => parseAndValidateUsageResponse(JSON.stringify(value)),
      AiResponseValidationError,
    );
  const flow = setup([
    {
      kind: "final",
      rawText: JSON.stringify({ commands: [{ ...candidate, command: "ls" }], failureReason: "" }),
    },
  ]);
  await assert.rejects(flow.run, AiResponseValidationError);
});
