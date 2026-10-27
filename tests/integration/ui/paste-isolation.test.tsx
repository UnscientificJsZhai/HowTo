import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import React from "react";

import { MAX_PASTE_BYTES, PASTE_END, PASTE_START } from "../../../src/ui/paste-framing.js";
import {
  InteractiveSession,
  InteractiveSessionError,
} from "../../../src/ui/interactive-session.js";
import { importWithoutColor } from "../../helpers/import-without-color.js";
import {
  deferred,
  SessionFakeTty,
  sessionHarness,
  testCandidate,
  testRequest,
  waitFor,
} from "../../helpers/interactive-session.js";

const modules = importWithoutColor(() => import("../../../src/ui/run-interactive-command.js"));

for (const gap of [0, 25, 60]) {
  void test(`Esc 后 ${gap}ms 的完整粘贴保留独立数据通道，CR/LF 不产生回车`, async (t) => {
    await modules;
    const [{ render, Text }, { InteractiveSessionProvider }, { usePasteAwareInput }] =
      await Promise.all([
        import("ink"),
        import("../../../src/ui/InteractiveSessionProvider.js"),
        import("../../../src/ui/use-paste-aware-input.js"),
      ]);
    const h = sessionHarness();
    const keys: Array<{ input: string; enter: boolean; escape: boolean }> = [];
    const pastes: string[] = [];
    const Probe = () => {
      const ready = usePasteAwareInput({
        onInput: (input, key) => keys.push({ input, enter: key.return, escape: key.escape }),
        onPaste: (input) => pastes.push(input),
      });
      return ready ? <Text>INPUT_CHANNEL_READY</Text> : null;
    };
    const instance = render(
      <InteractiveSessionProvider session={h.session}>
        <Probe />
      </InteractiveSessionProvider>,
      {
        stdin: h.session.input,
        stdout: h.session.output,
        stderr: h.session.output,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
    t.after(async () => {
      instance.unmount();
      await instance.waitUntilExit();
      h.close();
    });
    await waitFor(() => h.text().includes("INPUT_CHANNEL_READY"), "输入探针未就绪");
    await h.send("\u001b");
    if (gap > 0) await delay(gap);
    await h.send(PASTE_START + "first\r\nsecond" + PASTE_END);
    await waitFor(() => pastes.length === 1, "粘贴未交付独立通道");
    assert.deepEqual(pastes, ["first\r\nsecond"]);
    assert.deepEqual(keys, [{ input: "", enter: false, escape: true }]);
  });
}

for (const [prefix, suffix] of [
  ["\u001b[", "13u"],
  ["\u001b[13;1:", "1u"],
  ["\u001bO", "M"],
  ["\u001b\u001b[", "13u"],
  ["\u001b", "[13u"],
]) {
  void test(`旧页面未完成按键 ${JSON.stringify(prefix)} 不能与新输入合成回车`, async (t) => {
    const { runInteractiveCommand } = await modules;
    const h = sessionHarness();
    t.after(() => h.close());
    const provider = deferred<{ rawText: string }>();
    let executed = 0;
    const result = runInteractiveCommand({
      session: h.session,
      provider: { generateCommands: () => provider.promise },
      request: testRequest(),
      execute: () => {
        executed++;
        return Promise.resolve(0);
      },
    });
    await waitFor(() => h.text().includes("Thinking"), "等待页未显示");
    await h.send(prefix);
    await delay(60);
    provider.resolve({ rawText: JSON.stringify({ commands: [testCandidate()] }) });
    await waitFor(() => h.text().includes("Select a command"), "候选未显示");
    await h.send(suffix);
    await delay(30);
    assert.equal(h.text().includes("Final command:"), false);
    await h.send("\r");
    await waitFor(() => h.text().includes("Final command:"), "独立 Enter 未选择候选");
    assert.equal(executed, 0);
    await h.send("\r");
    assert.equal(await result, 0);
    assert.equal(executed, 1);
  });
}

void test("每个占位符独立接收输入，同批回车和后续粘贴不能跳过字段或最终确认", async (t) => {
  const { runInteractiveCommand } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const notices: string[] = [];
  h.session.subscribeInputNotice((message) => notices.push(message));
  const candidate = {
    ...testCandidate("printf '%s %s' '{{first}}' '{{second}}'"),
    placeholders: [
      { name: "first", description: "FIRST_FIELD" },
      { name: "second", description: "SECOND_FIELD" },
    ],
  };
  const executed: string[] = [];
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () =>
        Promise.resolve({ rawText: JSON.stringify({ commands: [candidate] }) }),
    },
    request: testRequest(),
    execute: (command) => {
      executed.push(command);
      return Promise.resolve(0);
    },
  });
  await waitFor(() => h.text().includes("Select a command"), "候选未显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("FIRST_FIELD"), "首个字段未显示");
  await h.send(
    PASTE_START + "first\r\nline" + PASTE_END + "\r\r" + PASTE_START + "STALE_VALUE" + PASTE_END,
  );
  await waitFor(() => h.text().includes("SECOND_FIELD"), "第二个字段未显示");
  assert.equal(h.text().includes("Final command:"), false);
  assert.equal(h.text().includes("STALE_VALUE"), false);
  assert.ok(notices.some((message) => message.includes("上一页面或字段")));
  await h.send(PASTE_START + "second" + PASTE_END + "\r\r");
  await waitFor(() => h.text().includes("Final command:"), "最终确认未显示");
  assert.deepEqual(executed, []);
  await h.send("\r");
  assert.equal(await result, 0);
  assert.deepEqual(executed, ["printf '%s %s' 'first\r\nline' 'second'"]);
});

void test("跨字段的未完成粘贴整块丢弃，新粘贴仍可输入并正常执行", async (t) => {
  const { runInteractiveCommand } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const candidate = {
    ...testCandidate("printf '%s %s' '{{first}}' '{{second}}'"),
    placeholders: [
      { name: "first", description: "FIELD_ONE" },
      { name: "second", description: "FIELD_TWO" },
    ],
  };
  const executed: string[] = [];
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () =>
        Promise.resolve({ rawText: JSON.stringify({ commands: [candidate] }) }),
    },
    request: testRequest(),
    execute: (command) => {
      executed.push(command);
      return Promise.resolve(0);
    },
  });
  await waitFor(() => h.text().includes("Select a command"), "候选未显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("FIELD_ONE"), "首个字段未显示");
  await h.send("one\r" + PASTE_START + "OLD_");
  await waitFor(() => h.text().includes("FIELD_TWO"), "第二个字段未显示");
  await h.send("SECRET\r" + PASTE_END);
  await h.send(PASTE_START + "two" + PASTE_END + "\r");
  await waitFor(() => h.text().includes("Final command:"), "最终确认未显示");
  assert.equal(h.text().includes("SECRET"), false);
  assert.deepEqual(executed, []);
  await h.send("\r");
  assert.equal(await result, 0);
  assert.deepEqual(executed, ["printf '%s %s' 'one' 'two'"]);
});

for (const reason of ["idle", "prefix", "duration", "overflow"] as const) {
  void test(`异常粘贴 ${reason} 结束会话，恢复终端并拒绝执行`, async (t) => {
    const input = new SessionFakeTty();
    const output = new SessionFakeTty();
    output.resume();
    const session = new InteractiveSession(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      {
        pasteIdleTimeoutMs: reason === "idle" || reason === "prefix" ? 15 : 1_000,
        pasteDurationLimitMs: reason === "duration" ? 15 : 2_000,
      },
    );
    t.after(() => {
      session.dispose();
      input.destroy();
      output.destroy();
    });
    session.beginView();
    let failure: Error | undefined;
    session.subscribeFailure((error) => {
      failure = error;
    });
    input.write(
      reason === "prefix"
        ? PASTE_START.slice(0, -1)
        : PASTE_START +
            (reason === "overflow" ? "x".repeat(MAX_PASTE_BYTES + 1) : "pending\r\u0003"),
    );
    await waitFor(() => failure !== undefined, "异常粘贴未终止会话");
    assert.match(failure!.message, reason === "overflow" ? /超过 256 KiB/ : /时限内结束/);
    assert.equal(input.isRaw, false);
    assert.equal(input.refs, 0);
    assert.equal(session.input.destroyed, true);
    let actions = 0;
    assert.throws(
      () => session.handoff({ execute: () => ++actions, print: () => ++actions }),
      InteractiveSessionError,
    );
    assert.equal(actions, 0);
  });
}
