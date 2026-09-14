import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { importWithoutColor } from "./import-without-color.js";
import { sessionHarness, testCandidate, testRequest, waitFor } from "./session-test-helpers.js";

const modules = importWithoutColor(async () => {
  const [{ render }, { App }, { SelectCommandView }, { InteractiveSessionProvider }] =
    await Promise.all([
      import("ink"),
      import("../../../src/ui/App.js"),
      import("../../../src/ui/SelectCommandView.js"),
      import("../../../src/ui/InteractiveSessionProvider.js"),
    ]);
  return { render, App, SelectCommandView, InteractiveSessionProvider };
});

const down = "\u001b[B";
const up = "\u001b[A";
const enter = "\r";
const cases = [
  { label: "同块 Down+Enter", chunks: [down + enter], expected: 1 },
  { label: "同块 Up+Enter", chunks: [up + enter], expected: 2 },
  { label: "同块 Down 三次回绕后 Enter", chunks: [down + down + down + enter], expected: 0 },
  { label: "分块 Down 后 Enter", chunks: [down, enter], expected: 1 },
  { label: "已渲染第二项后同块 Down+Enter", chunks: [down, down + enter], expected: 2 },
  { label: "单候选上下回绕后 Enter", chunks: [up + down + enter], expected: 0, count: 1 },
];

for (const scenario of cases) {
  void test(`选择组件按顺序处理${scenario.label}`, async (t) => {
    const { SelectCommandView } = await modules;
    const candidates = createCandidates(scenario.count);
    const selected: CommandCandidateContract[] = [];
    let cancellations = 0;
    const view = await renderInSession(
      t,
      <SelectCommandView
        candidates={candidates}
        availableRows={23}
        onSelect={(value) => selected.push(value)}
        onCancel={() => cancellations++}
      />,
    );
    await waitFor(() => view.text().includes("Select a command"), "候选列表未显示");

    for (const chunk of scenario.chunks) await sendAndRender(view, chunk);
    await waitFor(() => selected.length > 0, "选择回调未触发");

    assert.equal(selected.length, 1);
    assert.equal(selected[0], candidates[scenario.expected]);
    assert.equal(cancellations, 0);
  });
}

// App 会话层抽样验证端到端顺序确认链路
for (const scenario of [cases[0], cases[2]]) {
  void test(`完整会话 App 按顺序确认${scenario.label}`, async (t) => {
    await checkAppSelection(t, scenario.chunks, scenario.expected, 24, 80, scenario.count);
  });
}

for (const [rows, columns] of [
  [2, 20],
  [4, 32],
]) {
  void test(`完整会话 App 在 ${columns} 列 ${rows} 行终端使用同块输入后的最新候选`, async (t) => {
    await checkAppSelection(t, [down + enter], 1, rows, columns);
  });
}

for (const [label, availableRows, isInputActive] of [
  ["不可见", 0, true],
  ["输入停用", 23, false],
] as const) {
  void test(`选择组件${label}时不更新索引或选择候选`, async (t) => {
    const { SelectCommandView, InteractiveSessionProvider } = await modules;
    const candidates = createCandidates();
    const selected: CommandCandidateContract[] = [];
    const onSelect = (value: CommandCandidateContract) => selected.push(value);
    const onCancel = () => assert.fail("停用的输入不能取消");
    const view = await renderInSession(
      t,
      <SelectCommandView
        candidates={candidates}
        availableRows={availableRows}
        isInputActive={isInputActive}
        onSelect={onSelect}
        onCancel={onCancel}
      />,
    );
    await sendAndRender(view, down + enter);
    assert.deepEqual(selected, []);

    view.instance.rerender(
      <InteractiveSessionProvider session={view.session}>
        <SelectCommandView
          candidates={candidates}
          availableRows={23}
          onSelect={onSelect}
          onCancel={onCancel}
        />
      </InteractiveSessionProvider>,
    );
    await bounded(view.instance.waitUntilRenderFlush());
    await sendAndRender(view, enter);
    await waitFor(() => selected.length > 0, "恢复后未选择候选");
    assert.deepEqual(selected, [candidates[0]]);
  });
}

function createCandidates(count = 3): CommandCandidateContract[] {
  return ["printf A", "printf B", "printf C"].slice(0, count).map(testCandidate);
}

async function checkAppSelection(
  t: TestContext,
  chunks: string[],
  expected: number,
  rows: number,
  columns: number,
  count = 3,
): Promise<void> {
  const { App } = await modules;
  const candidates = createCandidates(count);
  const successes: string[] = [];
  const errors: Error[] = [];
  let providerCalls = 0;
  const view = await renderInSession(
    t,
    <App
      provider={{
        generateCommands: () => {
          providerCalls++;
          return Promise.resolve({ rawText: JSON.stringify({ commands: candidates }) });
        },
      }}
      request={testRequest()}
      onSuccess={(command) => successes.push(command)}
      onError={(error) => errors.push(error)}
    />,
    rows,
    columns,
  );
  await waitFor(
    () => view.text().includes(rows <= 4 ? `1/${count}` : "Select a command"),
    "完整 App 未显示候选列表",
  );

  let confirmationOffset = view.text().length;
  for (let index = 0; index < chunks.length; index++) {
    if (index === chunks.length - 1) confirmationOffset = view.text().length;
    await sendAndRender(view, chunks[index]);
  }
  await waitFor(() => {
    const output = view.text().slice(confirmationOffset);
    if (rows >= 4) return output.includes("Final command:");
    if (rows === 3) return output.includes("Enter=run Esc=cancel");
    return output
      .split("\n")
      .some((line) => line.includes(" Enter Esc") && !line.includes("UD Enter Esc"));
  }, "完整 App 未进入最终确认");
  await bounded(view.instance.waitUntilRenderFlush());
  const preview = view.text().slice(confirmationOffset);
  assert.deepEqual(successes, []);

  // 第二个独立 Enter 才确认最终命令；回调仅记录，不调用执行器。
  await sendAndRender(view, enter);
  await waitFor(() => successes.length > 0 || errors.length > 0, "App 未返回最终结果");
  assert.deepEqual(errors, []);
  assert.equal(successes.length, 1);
  assert.equal(providerCalls, 1);
  assert.equal(view.session.getExecutionPolicy(), "execute");
  assert.ok(preview.includes(successes[0]), "确认预览和实际回调命令不一致");
  assert.deepEqual(successes, [candidates[expected].command]);
}

async function renderInSession(t: TestContext, element: React.ReactNode, rows = 24, columns = 80) {
  const { render, InteractiveSessionProvider } = await modules;
  const h = sessionHarness(rows, columns);
  let unmount = () => {};
  t.after(async () => {
    try {
      unmount();
      await nextTurn();
    } finally {
      h.close();
    }
  });
  const instance = render(
    <InteractiveSessionProvider session={h.session}>{element}</InteractiveSessionProvider>,
    {
      stdin: h.session.input,
      stdout: h.session.output,
      stderr: h.session.output,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: false,
    },
  );
  unmount = () => instance.unmount();
  await bounded(instance.waitUntilRenderFlush());
  await nextTurn();
  return { ...h, instance };
}

async function sendAndRender(
  view: Awaited<ReturnType<typeof renderInSession>>,
  chunk: string,
): Promise<void> {
  // 同一字符串只写一次物理输入，方向键和 Enter 之间不等待 React。
  await view.send(chunk);
  await bounded(view.instance.waitUntilRenderFlush());
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("渲染握手超时")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
