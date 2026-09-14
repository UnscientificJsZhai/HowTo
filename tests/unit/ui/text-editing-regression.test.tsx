import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import React from "react";
import type { AppConfig } from "../../../src/config.js";
import type { InitializationValues } from "../../../src/init/index.js";
import { importWithoutColor } from "./import-without-color.js";
import { sessionHarness, testCandidate, testRequest, waitFor } from "./session-test-helpers.js";

const modules = importWithoutColor(async () => {
  const [
    { render },
    { InitializationApp },
    { ConfirmView },
    { InteractiveSessionProvider },
    runner,
  ] = await Promise.all([
    import("ink"),
    import("../../../src/init/InitializationApp.js"),
    import("../../../src/ui/ConfirmView.js"),
    import("../../../src/ui/InteractiveSessionProvider.js"),
    import("../../../src/ui/run-interactive-command.js"),
  ]);
  return { render, InitializationApp, ConfirmView, InteractiveSessionProvider, ...runner };
});

const graphemes = ["😀", "𠮷", "e\u0301", "👩🏽‍💻"];
const backspace = "\u007f";
const deleteKey = "\u001b[3~";

for (const grapheme of graphemes) {
  void test(`完整 App 删除 ${grapheme} 后向执行出口交付正确的 UTF-8 命令`, async (t) => {
    const { runInteractiveCommand } = await modules;
    const h = sessionHarness();
    t.after(() => h.close());
    const prefix = "e\u0301-𠮷/";
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
        // 不解释命令；真实子进程往返验证执行出口的参数编码没有替换字符。
        const child = spawnSync(
          process.execPath,
          ["-e", "process.stdout.write(process.argv[1])", command],
          {
            timeout: 5000,
          },
        );
        assert.ifError(child.error);
        assert.equal(child.status, 0);
        assert.deepEqual(child.stdout, Buffer.from(expected, "utf8"));
        assert.equal(child.stderr.length, 0);
        return Promise.resolve(0);
      },
      print: () => assert.fail("纯键盘会话不应切换为仅输出"),
    });

    await waitFor(() => h.text().includes("Select a command"), "候选列表未显示");
    await h.send("\r");
    await waitFor(() => h.text().includes("Fill command placeholders"), "占位符输入未显示");
    // 文本和两种删除键同批到达；独立 Enter 不与未分帧文本中的 CR 混淆。
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
    const prefixes = ["FAKE-e\u0301-", "model-𠮷-", "https://example.invalid/"];
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
    for (const value of [
      submissions[0].apiKey,
      submissions[0].model,
      submissions[0].openaiBaseUrl ?? "",
    ]) {
      assert.equal(Buffer.from(value, "utf8").toString("utf8"), value);
    }
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

async function renderInSession(t: TestContext, element: React.ReactNode) {
  const { render, InteractiveSessionProvider } = await modules;
  const h = sessionHarness();
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
