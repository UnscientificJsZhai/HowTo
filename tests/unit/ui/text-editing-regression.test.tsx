import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import type { AppConfig } from "../../../src/config.js";
import type { InitializationValues } from "../../../src/init/index.js";
import { importWithoutColor } from "./import-without-color.js";
import {
  deferred,
  sessionHarness,
  testCandidate,
  testRequest,
  waitFor,
} from "./session-test-helpers.js";
import { InteractionCancelledError } from "../../../src/ui/tty.js";

const modules = importWithoutColor(async () => {
  const [
    { render },
    { InitializationApp },
    { ConfirmView },
    { InteractiveSessionProvider },
    runner,
    { App },
  ] = await Promise.all([
    import("ink"),
    import("../../../src/init/InitializationApp.js"),
    import("../../../src/ui/ConfirmView.js"),
    import("../../../src/ui/InteractiveSessionProvider.js"),
    import("../../../src/ui/run-interactive-command.js"),
    import("../../../src/ui/App.js"),
  ]);
  return { render, InitializationApp, ConfirmView, InteractiveSessionProvider, App, ...runner };
});

const graphemes = ["😀", "𠮷", "é", "👩🏽‍💻"];
const backspace = "\u007f";
const deleteKey = "\u001b[3~";

for (const grapheme of graphemes) {
  void test(`完整 App 删除 ${grapheme} 后向执行出口交付正确的 UTF-8 命令`, async (t) => {
    const { runInteractiveCommand } = await modules;
    const h = sessionHarness();
    t.after(() => h.close());
    const prefix = "é-𠮷/";
    const expected = `printf '%s' '${prefix}safe'`;
    const executions: string[] = [];
    const candidate = {
      ...testCandidate("printf '%s' '{{value}}'"),
      placeholders: [{ name: "value", description: "输入待打印的测试值" }],
    };
    const result = runInteractiveCommand({
      session: h.session,
      provider: {
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [candidate] }) }),
      },
      request: testRequest(),
      execute: (command) => {
        executions.push(command);
        return Promise.resolve(0);
      },
      print: () => assert.fail("纯键盘会话不应切换为仅输出"),
    });

    await waitFor(() => h.text().includes("Select a command"), "候选列表未显示");
    await h.send("\r");
    await waitFor(() => h.text().includes("Fill command placeholders"), "占位符输入未显示");
    // 文本和两种删除键同批到达，删除后继续确认最终值。
    await h.send(`${prefix}${grapheme}${backspace}${grapheme}${deleteKey}safe`);
    await h.send("\r");
    await waitFor(() => h.text().includes("Final command:"), "最终确认未显示");
    assert.deepEqual(executions, []);
    await h.send("\r");

    assert.equal(await bounded(result), 0);
    assert.deepEqual(executions, [expected]);
    assert.equal(h.session.getExecutionPolicy(), "execute");
  });

  void test(`初始化三类字段删除 ${grapheme} 后提交完整原值`, async (t) => {
    const { InitializationApp } = await modules;
    const submissions: InitializationValues[] = [];
    const view = await renderInSession(
      t,
      <InitializationApp
        onSubmit={(values) => {
          submissions.push(values);
          return Promise.resolve(testConfig());
        }}
        onComplete={() => {}}
        onCancel={() => assert.fail("删除字素簇不应取消初始化")}
        onError={(error) => assert.fail(error.message)}
      />,
    );
    await sendAndFlush(view, "1");
    const prefixes = ["FAKE-é-", "model-𠮷-", "https://example.invalid/"];
    for (const prefix of prefixes) {
      await sendAndFlush(view, `${prefix}${grapheme}${backspace}${grapheme}${deleteKey}saved`);
      await sendAndFlush(view, "\r");
    }

    await waitFor(() => submissions.length > 0, "初始化未提交");
    assert.deepEqual(submissions, [
      {
        provider: "openai",
        apiKey: `${prefixes[0]}saved`,
        model: `${prefixes[1]}saved`,
        openaiBaseUrl: `${prefixes[2]}saved`,
      },
    ]);
    assert.equal(view.session.getExecutionPolicy(), "execute");
  });

  void test(`危险确认删除 ${grapheme} 后仍能一次提交 EXECUTE`, async (t) => {
    const { ConfirmView } = await modules;
    let confirmations = 0;
    let cancellations = 0;
    const view = await renderInSession(
      t,
      <ConfirmView
        candidate={testCandidate()}
        command={testCandidate().command}
        resolvedValues={new Map()}
        danger={{ rule: "测试风险", reason: "只验证确认回调" }}
        onConfirm={() => confirmations++}
        onCancel={() => cancellations++}
      />,
    );
    await sendAndFlush(view, `EXECUTE${grapheme}${backspace}${grapheme}${deleteKey}\r`);
    assert.equal(confirmations, 1);
    assert.equal(cancellations, 0);
    assert.equal(view.session.getExecutionPolicy(), "execute");
  });
}

void test("初始化拒绝真实 Alt/Meta 文本事件并保留 Shift 字符及同批字段提交", async (t) => {
  const { InitializationApp } = await modules;
  const submissions: InitializationValues[] = [];
  const view = await renderInSession(
    t,
    <InitializationApp
      onSubmit={(values) => {
        submissions.push(values);
        return Promise.resolve(testConfig());
      }}
      onComplete={() => {}}
      onCancel={() => assert.fail("Alt/Meta 快捷键不应取消初始化")}
      onError={(error) => assert.fail(error.message)}
    />,
  );
  await sendAndFlush(view, "1");
  for (const value of ["FAKE-AbC!", "Model-Z", "https://example.invalid/AbC"]) {
    await sendAndFlush(view, `${value}\u001bb\u001bf\r`);
  }

  await waitFor(() => submissions.length > 0, "初始化未提交");
  assert.deepEqual(submissions, [
    {
      provider: "openai",
      apiKey: "FAKE-AbC!",
      model: "Model-Z",
      openaiBaseUrl: "https://example.invalid/AbC",
    },
  ]);
  assert.equal(view.session.getExecutionPolicy(), "execute");
});

const enterPress = "\u001b[13;1:1u";
const enterRelease = "\u001b[13;1:3u";
const backspacePress = "\u001b[127;1:1u";
const backspaceRelease = "\u001b[127;1:3u";
const deletePress = "\u001b[3;1:1~";
const deleteRelease = "\u001b[3;1:3~";

for (const hasPlaceholder of [false, true]) {
  for (const pasted of [false, true]) {
    void test(`Enter 释放事件不会跨越${hasPlaceholder ? "占位符" : "候选选择"}后的${pasted ? "仅输出" : "执行"}确认`, async (t) => {
      const { App } = await modules;
      const command = hasPlaceholder ? "printf '%s' '{{value}}'" : "printf keyboard-safe";
      const candidate = {
        ...testCandidate(command),
        placeholders: hasPlaceholder ? [{ name: "value", description: "测试值" }] : [],
      };
      const confirmed: string[] = [];
      const view = await renderInSession(
        t,
        <App
          provider={{
            generateCommands: () =>
              Promise.resolve({ rawText: JSON.stringify({ commands: [candidate] }) }),
          }}
          request={testRequest()}
          onSuccess={(value) => confirmed.push(value)}
          onError={(error) => assert.fail(error.message)}
        />,
      );
      await waitFor(() => view.text().includes("Select a command"), "候选未显示");
      if (pasted) await sendAndFlush(view, "\u001b[200~\u001b[201~");
      await sendAndFlush(view, enterPress);
      if (hasPlaceholder) {
        await sendAndFlush(view, enterRelease);
        await sendAndFlush(view, "abc");
        await sendAndFlush(view, backspacePress);
        await sendAndFlush(view, backspaceRelease);
        await sendAndFlush(view, enterPress);
      }
      await waitFor(
        () => view.text().includes(pasted ? "仅输出:" : "Final command:"),
        "最终确认未显示",
      );
      assert.deepEqual(confirmed, []);
      await sendAndFlush(view, enterRelease);
      await sendAndFlush(view, "\u001b[27;1:3u\u001b[99;5:3u");
      assert.deepEqual(confirmed, []);
      await sendAndFlush(view, enterPress);
      assert.deepEqual(confirmed, [hasPlaceholder ? "printf '%s' 'ab'" : command]);
      assert.equal(view.session.getExecutionPolicy(), pasted ? "print" : "execute");
    });
  }
}

void test("候选导航忽略方向键释放事件，保留最后一次实际移动", async (t) => {
  const { App } = await modules;
  const confirmed: string[] = [];
  const candidates = ["printf first", "printf second", "printf third"].map(testCandidate);
  const view = await renderInSession(
    t,
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: candidates }) }),
      }}
      request={testRequest()}
      onSuccess={(command) => confirmed.push(command)}
      onError={(error) => assert.fail(error.message)}
    />,
  );
  await waitFor(() => view.text().includes("Select a command"), "候选未显示");
  await sendAndFlush(view, "\u001b[1;1:1B\u001b[1;1:3B");
  await sendAndFlush(view, "\r");
  await sendAndFlush(view, "\r");
  assert.deepEqual(confirmed, ["printf second"]);
});

void test("加载时 Ctrl+C release 不取消请求，press 仍立即取消", async (t) => {
  const { App } = await modules;
  const pending = deferred<{ rawText: string }>();
  let signal: AbortSignal | undefined;
  const errors: Error[] = [];
  const view = await renderInSession(
    t,
    <App
      provider={{
        generateCommands: (_request, currentSignal) => {
          signal = currentSignal;
          return pending.promise;
        },
      }}
      request={testRequest()}
      onSuccess={() => assert.fail("加载时不应确认")}
      onError={(error) => errors.push(error)}
    />,
  );
  await waitFor(() => signal !== undefined, "请求未启动");
  await sendAndFlush(view, "\u001b[99;5:3u");
  assert.equal(signal?.aborted, false);
  assert.equal(errors.length, 0);
  await sendAndFlush(view, "\u001b[99;5:1u");
  assert.equal(signal?.aborted, true);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof InteractionCancelledError);
});

void test("初始化 Enter 与 Backspace 的 press/release 各只生效一次", async (t) => {
  const { InitializationApp } = await modules;
  const submissions: InitializationValues[] = [];
  const view = await renderInSession(
    t,
    <InitializationApp
      onSubmit={(values) => {
        submissions.push(values);
        return Promise.resolve(testConfig());
      }}
      onComplete={() => {}}
      onCancel={() => assert.fail("释放事件不应取消")}
      onError={(error) => assert.fail(error.message)}
    />,
  );
  await sendAndFlush(view, "\u001b[1;1:1B\u001b[1;1:3B");
  await sendAndFlush(view, enterPress);
  await sendAndFlush(view, enterRelease);
  await sendAndFlush(view, "FAKE-a");
  // 按下和重复各输入一个 b，释放不输入；之后只删除一个完整字符。
  await sendAndFlush(view, "\u001b[98;1:1u\u001b[98;1:2u\u001b[98;1:3u");
  await sendAndFlush(view, backspacePress);
  await sendAndFlush(view, backspaceRelease);
  await sendAndFlush(view, "\u001b[27;1:3u\u001b[99;5:3u");
  await sendAndFlush(view, enterPress);
  await sendAndFlush(view, enterRelease);
  await sendAndFlush(view, "model-test");
  await sendAndFlush(view, enterPress);
  await sendAndFlush(view, enterRelease);
  await sendAndFlush(view, "https://example.invalid/v1");
  await sendAndFlush(view, enterPress);
  await waitFor(() => submissions.length === 1, "初始化未完成");
  assert.deepEqual(submissions, [
    {
      provider: "openai",
      apiKey: "FAKE-ab",
      model: "model-test",
      openaiBaseUrl: "https://example.invalid/v1",
    },
  ]);
});

void test("危险确认不因 Backspace/Delete release 多删字符，Return release 不确认", async (t) => {
  const { ConfirmView } = await modules;
  let confirmations = 0;
  const view = await renderInSession(
    t,
    <ConfirmView
      candidate={testCandidate()}
      command={testCandidate().command}
      resolvedValues={new Map()}
      danger={{ rule: "测试风险", reason: "仅验证回调" }}
      onConfirm={() => confirmations++}
      onCancel={() => assert.fail("release 不应取消或修改确认短语")}
    />,
  );
  await sendAndFlush(view, "EXECUTEAX");
  await sendAndFlush(view, backspacePress);
  await sendAndFlush(view, backspaceRelease);
  await sendAndFlush(view, deletePress);
  await sendAndFlush(view, deleteRelease);
  await sendAndFlush(view, enterRelease);
  assert.equal(confirmations, 0);
  await sendAndFlush(view, enterPress);
  assert.equal(confirmations, 1);
});

for (const columns of [20, 36, 37]) {
  void test(`4 行 ${columns} 列危险确认显示输入并在扩缩宽度后保持编辑状态`, async (t) => {
    const { App } = await modules;
    const command = "rm -rf /private/tmp/FAKE-not-executed";
    const confirmed: string[] = [];
    const view = await renderInSession(
      t,
      <App
        provider={{
          generateCommands: () =>
            Promise.resolve({
              rawText: JSON.stringify({ commands: [testCandidate(command)] }),
            }),
        }}
        request={testRequest()}
        onSuccess={(value) => confirmed.push(value)}
        onError={(error) => assert.fail(error.message)}
      />,
      { rows: 4, columns },
    );
    await waitFor(() => view.text().includes("1/1"), "候选未显示");
    await sendAndFlush(view, "\r");
    await waitFor(() => view.text().includes("Final"), "危险确认未显示");
    let start = view.bytes().length;
    await sendAndFlush(view, "ABC");
    assert.ok(stripVTControlCharacters(view.bytes().subarray(start).toString()).includes("ABC"));
    for (const width of [40, columns]) {
      start = view.bytes().length;
      view.output.columns = width;
      view.output.resize(4);
      await bounded(view.instance.waitUntilRenderFlush());
      await waitFor(
        () => stripVTControlCharacters(view.bytes().subarray(start).toString()).includes("ABC"),
        "调整宽度后确认输入不可见",
      );
    }
    await sendAndFlush(view, `${backspace}${deleteKey}${backspace}EXECUTE`);
    assert.deepEqual(confirmed, []);
    await sendAndFlush(view, "\r");
    await waitFor(() => confirmed.length === 1, "编辑后的确认短语未提交");
    assert.deepEqual(confirmed, [command]);
  });
}

for (const command of ["2\\\n>/dev/null rm -rf /", "rm -rf ./../important", "dd of=///dev/disk2"]) {
  void test(`新修复的危险写法只有 EXECUTE 才交付原文：${JSON.stringify(command)}`, async () => {
    const { runInteractiveCommand } = await modules;
    for (const confirmation of ["\r", "EXECUTE\r"]) {
      const h = sessionHarness();
      const executions: string[] = [];
      const result = runInteractiveCommand({
        session: h.session,
        provider: {
          generateCommands: () =>
            Promise.resolve({ rawText: JSON.stringify({ commands: [testCandidate(command)] }) }),
        },
        request: testRequest(),
        execute: (value) => {
          executions.push(value);
          return Promise.resolve(0);
        },
      }).catch((error: unknown) => error);
      try {
        await waitFor(() => h.text().includes("Select a command"), "候选未显示");
        await h.send("\r");
        await waitFor(() => h.text().includes("EXECUTE+Enter"), "危险确认未显示");
        await h.send(confirmation);
        const outcome = await bounded(result);
        if (confirmation === "\r") {
          assert.ok(outcome instanceof InteractionCancelledError);
          assert.deepEqual(executions, []);
        } else {
          assert.equal(outcome, 0);
          assert.deepEqual(executions, [command]);
        }
      } finally {
        h.close();
      }
    }
  });
}

for (const chunks of [
  ["EXECUTE\r"],
  ["EXE", "CUT", "E", "\r"],
  ["EXECUTE\r\r"],
  ["EXECUTE\r\u0003"],
  ["EXECUTE", "\n"],
]) {
  void test(`确认文本与 Enter 分片后恰好完成一次：${JSON.stringify(chunks)}`, async (t) => {
    const { ConfirmView } = await modules;
    let confirmations = 0;
    let cancellations = 0;
    const view = await renderInSession(
      t,
      <ConfirmView
        candidate={testCandidate()}
        command={testCandidate().command}
        resolvedValues={new Map()}
        danger={{ rule: "测试风险", reason: "仅验证回调" }}
        onConfirm={() => confirmations++}
        onCancel={() => cancellations++}
      />,
    );
    for (const chunk of chunks) await sendAndFlush(view, chunk);
    assert.equal(confirmations, 1);
    assert.equal(cancellations, 0);
  });
}

for (const chunks of [["safe-value\r\rignored\r"], ["safe-", "value", "\r"]]) {
  void test(`占位符按键分片保持值且剩余 Enter 不进入最终确认：${JSON.stringify(chunks)}`, async (t) => {
    const { runInteractiveCommand } = await modules;
    const h = sessionHarness();
    t.after(() => h.close());
    const executions: string[] = [];
    const candidate = {
      ...testCandidate("printf '%s' '{{value}}'"),
      placeholders: [{ name: "value", description: "测试值" }],
    };
    const result = runInteractiveCommand({
      session: h.session,
      provider: {
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [candidate] }) }),
      },
      request: testRequest(),
      execute: (value) => {
        executions.push(value);
        return Promise.resolve(0);
      },
    });
    await waitFor(() => h.text().includes("Select a command"), "候选未显示");
    await h.send("\r\r");
    await waitFor(() => h.text().includes("Fill command placeholders"), "占位符未显示");
    for (const chunk of chunks) await h.send(chunk);
    await waitFor(() => h.text().includes("Final command:"), "最终确认未显示");
    assert.deepEqual(executions, []);
    await h.send("\r");
    assert.equal(await bounded(result), 0);
    assert.deepEqual(executions, ["printf '%s' 'safe-value'"]);
  });
}

void test("初始化同批键盘字段按顺序提交，提交后的输入不能再次完成或取消", async (t) => {
  const { InitializationApp } = await modules;
  const submissions: InitializationValues[] = [];
  const view = await renderInSession(
    t,
    <InitializationApp
      onSubmit={(value) => {
        submissions.push(value);
        return Promise.resolve(testConfig());
      }}
      onComplete={() => {}}
      onCancel={() => assert.fail("提交后的 Ctrl+C 不应再次取消")}
      onError={(error) => assert.fail(error.message)}
    />,
  );
  await sendAndFlush(view, "1");
  await sendAndFlush(view, "FAKE-key\rmodel-test\rhttps://example.invalid/v1\rignored\r\u0003");
  assert.deepEqual(submissions, [
    {
      provider: "openai",
      apiKey: "FAKE-key",
      model: "model-test",
      openaiBaseUrl: "https://example.invalid/v1",
    },
  ]);
});

void test("Kitty 文本码点中的 CR 保持数据，释放事件不追加或提交", async (t) => {
  const { runInteractiveCommand } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const executions: string[] = [];
  const candidate = {
    ...testCandidate("printf '%s' '{{value}}'"),
    placeholders: [{ name: "value", description: "测试值" }],
  };
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () =>
        Promise.resolve({ rawText: JSON.stringify({ commands: [candidate] }) }),
    },
    request: testRequest(),
    execute: (value) => {
      executions.push(value);
      return Promise.resolve(0);
    },
  });
  await waitFor(() => h.text().includes("Select a command"), "候选未显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("Fill command placeholders"), "占位符未显示");
  await h.send("\u001b[97;1:3;65:13:66u\u001b[97;1:1;65:13:66u");
  await h.send("\r");
  await waitFor(() => h.text().includes("Final command:"), "最终确认未显示");
  assert.deepEqual(executions, []);
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.deepEqual(executions, ["printf '%s' 'A\rB'"]);
});

async function renderInSession(
  t: TestContext,
  element: React.ReactNode,
  size = { rows: 24, columns: 80 },
) {
  const { render, InteractiveSessionProvider } = await modules;
  const h = sessionHarness(size.rows, size.columns);
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
  t.after(async () => {
    try {
      instance.unmount();
      await nextTurn();
    } finally {
      h.close();
    }
  });
  await bounded(instance.waitUntilRenderFlush());
  await nextTurn();
  return { ...h, instance };
}

async function sendAndFlush(
  view: Awaited<ReturnType<typeof renderInSession>>,
  input: string,
): Promise<void> {
  await view.send(input);
  await bounded(view.instance.waitUntilRenderFlush());
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("输入回归等待超时")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function testConfig(): AppConfig {
  return {
    aiProvider: "openai",
    gemini: { model: "gemini-3.1-flash-lite" },
    openai: { apiKey: "", model: "gpt-5.4-mini" },
    structuredOutput: true,
  };
}
