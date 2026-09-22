import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { CommandCandidateContract, GenerateCommandsRequest } from "../../../src/ai/types.js";
import { detectDangerousCommand } from "../../../src/safety/dangerous-command.js";
import { PASTE_START, PASTE_END } from "../../../src/ui/paste-framing.js";
import { InteractionCancelledError } from "../../../src/ui/tty.js";
import { importWithoutColor } from "./import-without-color.js";
import { sessionHarness, testCandidate, testRequest, waitFor } from "./session-test-helpers.js";

const modules = importWithoutColor(() => import("../../../src/ui/run-interactive-command.js"));

for (const [label, input, confirmed] of [
  ["未输入确认短语取消", "\r", false],
  ["正确短语确认执行", "EXECUTE\r", true],
] as const) {
  test(`仅 AI 标记的命令复用危险确认：${label}`, async (t) => {
    const candidate = aiCandidate("git reset --hard");
    assert.equal(detectDangerousCommand(candidate.command), undefined);
    const h = await startSession(t, [candidate]);
    await h.send("\r");
    await waitFor(() => h.text().includes("EXECUTE+Enter"), "AI 风险未进入危险确认");
    assert.ok(h.text().includes(`AI: ${candidate.dangerReason}`));
    assert.ok(h.text().includes("ai-flagged-dangerous-command"));
    await h.send(input);
    const result = await h.finish();
    if (confirmed) assert.equal(result, 7);
    else assert.ok(result instanceof InteractionCancelledError);
    assert.deepEqual(h.executions, confirmed ? [candidate.command] : []);
    assert.deepEqual(h.printed, []);
    assert.equal(h.requests.length, 1);
  });
}

for (const dangerous of [false, true]) {
  test(`占位符替换后合并最终命令风险，AI 标记=${dangerous}，不新增请求`, async (t) => {
    const candidate: CommandCandidateContract = {
      ...testCandidate(dangerous ? "find {{target}} -delete" : "rm -rf {{target}}"),
      dangerous,
      dangerReason: dangerous ? "会删除匹配的文件" : "",
      placeholders: [{ name: "target", description: "测试目标" }],
    };
    const value = dangerous ? "./AI_ONLY_TARGET" : "/private/tmp/STATIC_ONLY_TARGET";
    const finalCommand = candidate.command.replace("{{target}}", value);
    const h = await startSession(t, [candidate]);
    await h.send("\r");
    await waitFor(() => h.text().includes("Fill command placeholders"), "占位符没有显示");
    await h.send(`${value}\r`);
    await waitFor(() => h.text().includes("EXECUTE+Enter"), "最终命令未进入危险确认");
    assert.ok(h.text().includes(dangerous ? "ai-flagged-dangerous-command" : "destructive-rm"));
    assert.ok(h.text().includes(finalCommand));
    await h.send("EXECUTE\r");
    assert.equal(await h.finish(), 7);
    assert.deepEqual(h.executions, [finalCommand]);
    assert.equal(h.requests.length, 1);
    assert.equal(JSON.stringify(h.requests).includes(value), false);
  });
}

for (const dangerous of [false, true]) {
  test(`返回候选列表后只使用新候选的 AI 标记：${dangerous}`, async (t) => {
    const abandoned = {
      ...testCandidate("printf {{value}}"),
      dangerous: !dangerous,
      dangerReason: dangerous ? "" : "首次候选的风险",
      placeholders: [{ name: "value", description: "未完成的输入" }],
    };
    const selected = {
      ...testCandidate("printf selected-candidate"),
      dangerous,
      dangerReason: dangerous ? "第二候选的风险" : "",
    };
    const h = await startSession(t, [abandoned, selected]);
    await h.send("\r");
    await waitFor(() => h.text().includes("Fill command placeholders"), "占位符没有显示");
    const beforeBack = h.text().length;
    await h.send("\u001b");
    await waitFor(() => h.text().slice(beforeBack).includes("Select a command"), "没有返回选择页");
    const beforeSelect = h.text().length;
    await h.send("\u001b[B\r");
    await waitFor(
      () => h.text().slice(beforeSelect).includes("Final command:"),
      "最终确认没有显示",
    );
    const confirmation = h.text().slice(beforeSelect);
    assert.equal(confirmation.includes("EXECUTE+Enter"), dangerous);
    assert.equal(confirmation.includes("AI: 第二候选的风险"), dangerous);
    assert.equal(confirmation.includes("AI: 首次候选的风险"), false);
    await h.send(dangerous ? "EXECUTE\r" : "\r");
    assert.equal(await h.finish(), 7);
    assert.deepEqual(h.executions, [selected.command]);
    assert.equal(h.requests.length, 1);
  });
}

test("AI 风险原因安全预览，缩至紧凑高度仍只能按危险流程确认", async (t) => {
  const candidate = { ...aiCandidate("find . -delete"), dangerReason: "第一行\r\n第二行" };
  const h = await startSession(t, [candidate]);
  await h.send("\r");
  await waitFor(() => h.text().includes("EXECUTE+Enter"), "危险确认没有显示");
  assert.ok(h.text().includes("AI: 第一行\u240d\u240a第二行"));
  const beforeResize = h.text().length;
  h.output.columns = 30;
  h.output.resize(3);
  await waitFor(() => h.text().slice(beforeResize).includes("X=EXECUTE:"), "紧凑确认提示没有显示");
  await h.send("eXeCuTe\r\r");
  assert.equal(await h.finish(), 7);
  assert.deepEqual(h.executions, [candidate.command]);
});

test("AI 标记不会恢复粘贴后已撤销的执行权限", async (t) => {
  const candidate = aiCandidate("git clean -fd");
  const h = await startSession(t, [candidate]);
  await h.send("\r");
  await waitFor(() => h.text().includes("EXECUTE+Enter"), "危险确认没有显示");
  await h.send(PASTE_START + "EXECUTE" + PASTE_END);
  await waitFor(() => h.text().includes("仅输出:"), "粘贴后未切换为仅输出");
  await h.send("EXECUTE\r\r");
  assert.equal(await h.finish(), 0);
  assert.equal(h.session.getExecutionPolicy(), "print");
  assert.deepEqual(h.executions, []);
  assert.deepEqual(h.printed, [candidate.command]);
});

function aiCandidate(command: string): CommandCandidateContract {
  return { ...testCandidate(command), dangerous: true, dangerReason: "可能丢失工作区数据" };
}

async function startSession(t: TestContext, candidates: CommandCandidateContract[]) {
  const { runInteractiveCommand } = await modules;
  const h = sessionHarness(24, 160);
  t.after(() => h.close());
  const executions: string[] = [];
  const printed: string[] = [];
  const requests: GenerateCommandsRequest[] = [];
  let completed = false;
  const completion = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: (request) => {
        requests.push(request);
        return Promise.resolve({ rawText: JSON.stringify({ commands: candidates }) });
      },
    },
    request: testRequest(),
    // 仅记录最终交付的字符串，不执行测试中的危险命令。
    execute: (command) => {
      executions.push(command);
      return Promise.resolve(7);
    },
    print: (command) => printed.push(command),
  }).then(
    (exitCode) => {
      completed = true;
      return exitCode;
    },
    (error: unknown) => {
      completed = true;
      return error;
    },
  );
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  return {
    ...h,
    executions,
    printed,
    requests,
    async finish() {
      await waitFor(() => completed, "确认流程未完成");
      return completion;
    },
  };
}
