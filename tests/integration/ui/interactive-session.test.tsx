import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import React from "react";

import { DISABLE_PASTE, InteractiveSessionError } from "../../../src/ui/interactive-session.js";
import { PASTE_END, PASTE_START } from "../../../src/ui/paste-framing.js";
import { getConfigFilePath } from "../../../src/config-file.js";
import { InteractionCancelledError } from "../../../src/ui/tty.js";
import {
  deferred,
  sessionHarness,
  testCandidate,
  testRequest,
  waitFor,
} from "../../helpers/interactive-session.js";
import { importWithoutColor } from "../../helpers/import-without-color.js";

const modules = importWithoutColor(async () => {
  const [
    { render },
    { runInteractiveCommand, MANUAL_EXECUTION_NOTICE },
    { initializeConfig },
    { InitializationApp },
    { ConfirmView },
    { InteractiveSessionProvider },
  ] = await Promise.all([
    import("ink"),
    import("../../../src/ui/run-interactive-command.js"),
    import("../../../src/init/index.js"),
    import("../../../src/init/InitializationApp.js"),
    import("../../../src/ui/ConfirmView.js"),
    import("../../../src/ui/InteractiveSessionProvider.js"),
  ]);
  return {
    render,
    runInteractiveCommand,
    MANUAL_EXECUTION_NOTICE,
    initializeConfig,
    InitializationApp,
    ConfirmView,
    InteractiveSessionProvider,
  };
});

void test("清理中 destroy 的异步 error 在关闭前被接收，任何模式都不进入动作", () => {
  const moduleUrl = new URL("../../../src/ui/interactive-session.js", import.meta.url).href;
  const framingUrl = new URL("../../../src/ui/paste-framing.js", import.meta.url).href;
  const script = `
    import { PassThrough } from 'node:stream';
    import { setImmediate as nextTurn } from 'node:timers/promises';
    import { createInteractiveSession, DISABLE_PASTE } from ${JSON.stringify(moduleUrl)};
    import { PASTE_START, PASTE_END } from ${JSON.stringify(framingUrl)};
    const lateErrors = [];
    process.on('uncaughtException', error => lateErrors.push(error.message));
    class FakeTty extends PassThrough {
      isTTY = true; isRaw = false; rows = 24; columns = 80;
      ref() { return this; } unref() { return this; }
      setRawMode(enabled) { this.isRaw = enabled; return this; }
    }
    const reports = [];
    for (const policy of ['execute', 'print']) {
      for (const mode of ['disable-input', 'raw-input', 'disable-output', 'output-end']) {
        const input = new FakeTty();
        const output = new FakeTty();
        let closeEvents = 0;
        const closing = mode.includes('output') ? output : input;
        const foreignClose = () => closeEvents++;
        const foreignError = () => {};
        closing.on('close', foreignClose);
        if (policy === 'print') closing.on('error', foreignError);
        output.on('data', chunk => {
          if (chunk.toString() !== DISABLE_PASTE) return;
          if (mode === 'disable-input') input.destroy(new Error('FAKE-secret'));
          if (mode === 'disable-output') output.destroy(new Error('FAKE-secret'));
          if (mode === 'output-end') output.end();
        });
        const setRaw = input.setRawMode.bind(input);
        input.setRawMode = enabled => {
          if (!enabled && mode === 'raw-input') input.destroy(new Error('FAKE-secret'));
          return setRaw(enabled);
        };
        const session = createInteractiveSession({input, output});
        let failures = 0;
        session.subscribeFailure(() => { failures++; session.suspendViewInput(); });
        if (policy === 'print') input.write(PASTE_START + PASTE_END);
        let execute = 0, print = 0, message;
        try {
          session.handoff({execute: () => ++execute, print: () => ++print});
        } catch (error) { message = error.message; }
        await nextTurn();
        reports.push({policy, mode, execute, print, message, failures,
          closeEvents, foreignRetained: closing.listeners('close').includes(foreignClose),
          foreignErrorRetained: closing.listeners('error').includes(foreignError),
          errorListeners: closing.listenerCount('error'),
          closeListeners: closing.listenerCount('close')});
        session.dispose(); input.destroy(); output.destroy();
      }
    }
    await nextTurn();
    process.stdout.write(JSON.stringify({reports, lateErrors}));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout) as {
    reports: {
      policy: string;
      mode: string;
      execute: number;
      print: number;
      message: string;
      failures: number;
      closeEvents: number;
      foreignRetained: boolean;
      foreignErrorRetained: boolean;
      errorListeners: number;
      closeListeners: number;
    }[];
    lateErrors: string[];
  };
  assert.equal(value.reports.length, 8);
  for (const report of value.reports) {
    assert.equal(report.execute, 0, JSON.stringify(report));
    assert.equal(report.print, 0, JSON.stringify(report));
    assert.equal(report.message, "交互终端输入不可用。");
    assert.equal(report.failures, 1);
    assert.equal(report.closeEvents, 1);
    assert.equal(report.foreignRetained, true);
    assert.equal(report.foreignErrorRetained, report.policy === "print");
    assert.equal(report.errorListeners, report.policy === "print" ? 1 : 0);
    assert.equal(report.closeListeners, 1);
  }
  assert.deepEqual(value.lateErrors, []);
  assert.equal(result.stderr.includes("FAKE-secret"), false);
});

void test("UI 最终清理时输入或输出 destroy(error) 会拒绝运行，最外层执行与输出均为零", async (t) => {
  const { runInteractiveCommand } = await modules;
  for (const stream of ["input", "output"] as const) {
    const h = sessionHarness();
    t.after(() => h.close());
    let executions = 0;
    let printed = 0;
    h.output.on("data", (chunk: Buffer) => {
      if (chunk.toString() === DISABLE_PASTE) h[stream].destroy(new Error("FAKE-secret"));
    });
    const result = runInteractiveCommand({
      session: h.session,
      provider: {
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [testCandidate()] }) }),
      },
      request: testRequest(),
      execute: () => {
        executions++;
        return Promise.resolve(0);
      },
      print: () => printed++,
    });
    const rejected = assert.rejects(result, (error: Error) => {
      assert.ok(error instanceof InteractiveSessionError);
      assert.equal(error.message, "交互终端输入不可用。");
      return true;
    });
    await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
    await h.send("\r");
    await waitFor(() => h.text().includes("Final command:"), "最终确认没有显示");
    await h.send("\r");
    await bounded(rejected);
    await waitFor(() => h[stream].listenerCount("error") === 0, "关闭后的尾部错误监听没有回收");
    assert.equal(executions, 0);
    assert.equal(printed, 0);
    assert.equal(h.text().includes("FAKE-secret"), false);
  }
});

void test("卸载后恢复 raw 和 ref 期间的未闭合粘贴拒绝执行", async (t) => {
  const { runInteractiveCommand } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const originalRaw = h.input.setRawMode.bind(h.input);
  const originalUnref = h.input.unref.bind(h.input);
  h.input.setRawMode = (enabled) => {
    if (!enabled) h.input.write(PASTE_START.slice(0, 3));
    return originalRaw(enabled);
  };
  h.input.unref = () => {
    h.input.write(PASTE_START.slice(3));
    return originalUnref();
  };
  let executions = 0;
  const printed: string[] = [];
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () =>
        Promise.resolve({ rawText: JSON.stringify({ commands: [testCandidate()] }) }),
    },
    request: testRequest(),
    execute: () => {
      executions++;
      return Promise.resolve(0);
    },
    print: (command) => printed.push(command),
  });
  const rejected = assert.rejects(result, /尚未结束/);
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("Final command:"), "最终确认没有显示");
  assert.equal(h.session.getExecutionPolicy(), "execute");
  await h.send("\r");
  await bounded(rejected);
  assert.equal(executions, 0);
  assert.deepEqual(printed, []);
  assert.equal(h.session.getExecutionPolicy(), "execute");
});

void test("真实最外层调度保持纯键盘普通和危险确认行为，取消始终不执行", async (t) => {
  const { runInteractiveCommand } = await modules;
  for (const scenario of [
    { command: "printf session-safe", keys: "\r", executed: 1 },
    { command: "rm -rf /private/tmp/FAKE-not-executed", keys: "EXECUTE\r", executed: 1 },
    { command: "rm -rf /private/tmp/FAKE-not-executed", keys: "WRONG\r", executed: 0 },
    { command: "printf session-safe", keys: "\u001b", executed: 0 },
    { command: "printf session-safe", keys: "\u0003", executed: 0 },
  ]) {
    const h = sessionHarness();
    t.after(() => h.close());
    const executions: string[] = [];
    const printed: string[] = [];
    const result = runInteractiveCommand({
      session: h.session,
      provider: {
        generateCommands: () =>
          Promise.resolve({
            rawText: JSON.stringify({ commands: [testCandidate(scenario.command)] }),
          }),
      },
      request: testRequest(),
      execute: (command) => {
        executions.push(command);
        return Promise.resolve(7);
      },
      print: (command) => printed.push(command),
    });
    const completion =
      scenario.executed === 0 ? assert.rejects(result, InteractionCancelledError) : result;
    await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
    await h.send("\r");
    await waitFor(
      () => h.text().includes("Final command:") || h.text().includes("EXECUTE+Enter"),
      "最终确认没有显示",
    );
    if (scenario.keys.length > 1 && scenario.keys.endsWith("\r")) {
      await h.send(scenario.keys.slice(0, -1));
      await h.send("\r");
    } else await h.send(scenario.keys);
    if (scenario.executed === 1) assert.equal(await bounded<number | void>(completion), 7);
    else await bounded<number | void>(completion);
    assert.deepEqual(executions, scenario.executed ? [scenario.command] : []);
    assert.deepEqual(printed, []);
  }
});

void test("危险确认忽略粘贴的 EXECUTE，随后 Enter 只取消且不执行", async (t) => {
  const { runInteractiveCommand } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const command = "rm -rf /private/tmp/FAKE-not-executed";
  let executions = 0;
  const printed: string[] = [];
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () =>
        Promise.resolve({
          rawText: JSON.stringify({ commands: [testCandidate(command)] }),
        }),
    },
    request: testRequest(),
    execute: () => {
      executions++;
      return Promise.resolve(0);
    },
    print: (value) => printed.push(value),
  });
  const rejected = assert.rejects(result, InteractionCancelledError);
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("EXECUTE+Enter"), "危险确认没有显示");
  await h.send(PASTE_START + "EXECUTE" + PASTE_END + "\r");
  await bounded(rejected);
  assert.equal(executions, 0);
  assert.deepEqual(printed, []);
  h.input.write(PASTE_END + "EXECUTE\r\r");
  assert.equal(h.session.getExecutionPolicy(), "execute");
  assert.equal(executions, 0);
});

void test("loading 隐藏与 done 卸载阶段的粘贴都由最终调度重新检查", async (t) => {
  const { runInteractiveCommand } = await modules;
  for (const phase of ["loading", "hidden", "unmount"]) {
    const h = sessionHarness();
    t.after(() => h.close());
    const provider = deferred<{ rawText: string }>();
    let executions = 0;
    const printed: string[] = [];
    const result = runInteractiveCommand({
      session: h.session,
      provider: { generateCommands: () => provider.promise },
      request: testRequest(),
      execute: () => {
        executions++;
        return Promise.resolve(0);
      },
      print: (value) => printed.push(value),
    });
    await waitFor(() => h.text().includes("Thinking"), "loading 没有显示");
    if (phase === "hidden") h.output.resize(1);
    if (phase !== "unmount") await h.send(PASTE_START + PASTE_END);
    if (phase === "hidden") h.output.resize(24);
    provider.resolve({ rawText: JSON.stringify({ commands: [testCandidate()] }) });
    await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
    await h.send("\r");
    await waitFor(() => h.text().includes("Final command:"), "确认没有显示");
    if (phase === "unmount") {
      assert.equal(h.session.getExecutionPolicy(), "execute");
      h.output.on("data", (chunk: Buffer) => {
        if (chunk.includes(Buffer.from("\u001b[?25h"))) h.input.write(PASTE_START + PASTE_END);
      });
    }
    await h.send("\r");
    assert.equal(await bounded(result), 0);
    assert.equal(executions, 1, phase);
    assert.deepEqual(printed, []);
  }
});

void test("输入 error end close 与输出 error 会结束运行并恢复资源", async (t) => {
  const { runInteractiveCommand } = await modules;
  for (const event of ["error", "end", "close", "output-error", "output-close", "output-finish"]) {
    const h = sessionHarness();
    t.after(() => h.close());
    let executions = 0;
    const result = runInteractiveCommand({
      session: h.session,
      provider: { generateCommands: () => new Promise(() => {}) },
      request: testRequest(),
      execute: () => {
        executions++;
        return Promise.resolve(0);
      },
      print: () => assert.fail("失败不能输出命令"),
    });
    const failure = assert.rejects(
      result,
      (error: Error) =>
        error instanceof InteractiveSessionError && !error.message.includes("FAKE-secret"),
    );
    await waitFor(() => h.text().includes("Thinking"), "loading 没有显示");
    if (event === "output-error") h.output.emit("error", new Error("FAKE-secret"));
    else if (event === "output-close") h.output.destroy();
    else if (event === "output-finish") h.output.end();
    else if (event === "error") h.input.emit("error", new Error("FAKE-secret"));
    else if (event === "end") h.input.end();
    else h.input.destroy();
    await bounded(failure);
    assert.equal(executions, 0);
    assert.equal(h.input.isRaw, false);
    assert.equal(h.input.listenerCount("readable"), 0);
    assert.equal(h.output.listenerCount("resize"), 0);
  }
});

void test("自动初始化粘贴保存后继续共享终端并正常执行", async (t) => {
  const { initializeConfig, runInteractiveCommand } = await modules;
  const home = await mkdtemp(join(tmpdir(), "howto-ui-init-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const h = sessionHarness();
  t.after(() => h.close());
  const initialization = initializeConfig({
    cliOptions: { print: false },
    env: { HOME: home },
    session: h.session,
  });
  await waitFor(() => h.text().includes("Choose AI provider"), "初始化没有显示");
  await h.send("1");
  await waitFor(() => h.text().includes("Configure openai"), "配置字段没有显示");
  await h.send(PASTE_START + "FAKE-key-only" + PASTE_END + "\r");
  await h.send("\r");
  await h.send("\r");
  const config = await bounded(initialization);
  assert.equal(config.openai.apiKey, "FAKE-key-only");
  const saved = JSON.parse(await readFile(getConfigFilePath({ HOME: home }), "utf8")) as {
    openaiApiKey: string;
  };
  assert.equal(saved.openaiApiKey, "FAKE-key-only");
  assert.equal(h.input.isRaw, true);
  assert.deepEqual(h.input.rawChanges, [true]);
  assert.equal(h.bytes().includes(Buffer.from(DISABLE_PASTE)), false);
  assert.equal(h.session.getExecutionPolicy(), "execute");
  await h.send(PASTE_START + "GAP");
  const printed: string[] = [];
  let executions = 0;
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () =>
        Promise.resolve({ rawText: JSON.stringify({ commands: [testCandidate()] }) }),
    },
    request: testRequest(),
    execute: () => {
      executions++;
      return Promise.resolve(0);
    },
    print: (value) => printed.push(value),
  });
  await waitFor(() => h.text().includes("Select a command"), "初始化后候选没有显示");
  await h.send(PASTE_END);
  await h.send("\r");
  await waitFor(() => h.text().includes("Final command:"), "仅输出确认没有显示");
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executions, 1);
  assert.deepEqual(printed, []);
  assert.deepEqual(h.input.rawChanges, [true, false]);
});

void test("隐藏粘贴整块丢弃，既有占位符仍可执行且初始化不保存隐藏片段", async (t) => {
  const { runInteractiveCommand, initializeConfig } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const command = {
    ...testCandidate("printf {{value}}"),
    placeholders: [{ name: "value", description: "测试值" }],
  };
  let executions = 0;
  const printed: string[] = [];
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () => Promise.resolve({ rawText: JSON.stringify({ commands: [command] }) }),
    },
    request: testRequest(),
    execute: () => {
      executions++;
      return Promise.resolve(0);
    },
    print: (value) => printed.push(value),
  });
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("Fill command placeholders"), "占位符没有显示");
  await h.send("kept");
  await h.send(PASTE_START);
  h.output.resize(1);
  await h.send("HIDDEN");
  h.output.resize(24);
  await h.send(PASTE_END);
  await h.send("\r");
  await waitFor(() => h.text().includes("Final command:"), "输出确认没有显示");
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executions, 1);
  assert.deepEqual(printed, []);
  assert.equal(h.text().includes("HIDDEN"), false);

  const home = await mkdtemp(join(tmpdir(), "howto-ui-hidden-init-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const init = sessionHarness();
  t.after(() => init.close());
  const initialization = initializeConfig({
    cliOptions: { print: false },
    env: { HOME: home },
    session: init.session,
  });
  await waitFor(() => init.text().includes("Choose AI provider"), "初始化没有显示");
  await init.send("1");
  await waitFor(() => init.text().includes("Configure openai"), "字段没有显示");
  await init.send("FAKE-kept");
  await init.send(PASTE_START);
  init.output.resize(1);
  await init.send("HIDDEN");
  init.output.resize(24);
  await init.send(PASTE_END);
  await init.send("\r");
  await init.send("\r");
  await init.send("\r");
  const config = await bounded(initialization);
  assert.equal(config.openai.apiKey, "FAKE-kept");
  const file = await readFile(getConfigFilePath({ HOME: home }), "utf8");
  assert.equal(file.includes("HIDDEN"), false);
  assert.equal(init.text().includes("HIDDEN"), false);
});

void test("保存中和初始化卸载空隙的粘贴不影响后续 App 执行", async (t) => {
  const { render, InitializationApp, InteractiveSessionProvider, runInteractiveCommand } =
    await modules;
  for (const phase of ["saving", "gap"]) {
    const h = sessionHarness();
    t.after(() => h.close());
    const save = deferred<import("../../../src/config.js").AppConfig>();
    let submissions = 0;
    let completed = false;
    const config = {
      aiProvider: "openai" as const,
      chatgpt: {},
      openai: { apiKey: "FAKE-key", model: "test-model" },
      gemini: { model: "test-model" },
      structuredOutput: true,
    };
    const instance = render(
      <InteractiveSessionProvider session={h.session}>
        <InitializationApp
          onSubmit={() => {
            submissions++;
            return save.promise;
          }}
          onComplete={() => {
            completed = true;
          }}
          onCancel={() => assert.fail("不应取消")}
          onError={(error) => {
            throw error;
          }}
        />
      </InteractiveSessionProvider>,
      {
        stdin: h.session.input,
        stdout: h.session.output,
        interactive: true,
        patchConsole: false,
        exitOnCtrlC: false,
      },
    );
    await instance.waitUntilRenderFlush();
    await h.send("1");
    await waitFor(() => h.text().includes("Configure openai"), "初始化字段没有显示");
    await h.send("FAKE-key");
    await h.send("\r");
    await h.send("\r");
    await h.send("\r");
    await waitFor(() => submissions === 1, "保存回调尚未开始");
    assert.equal(h.session.getExecutionPolicy(), "execute");
    if (phase === "saving") await h.send(PASTE_START + "IGNORED" + PASTE_END);
    save.resolve(config);
    await waitFor(() => completed, "保存尚未完成");
    instance.unmount();
    await instance.waitUntilExit();
    assert.equal(h.input.isRaw, true);
    assert.equal(h.bytes().includes(Buffer.from(DISABLE_PASTE)), false);
    if (phase === "gap") await h.send(PASTE_START + "IGNORED" + PASTE_END);
    let executions = 0;
    const printed: string[] = [];
    const result = runInteractiveCommand({
      session: h.session,
      provider: {
        generateCommands: () =>
          Promise.resolve({
            rawText: JSON.stringify({ commands: [testCandidate()] }),
          }),
      },
      request: testRequest(),
      execute: () => {
        executions++;
        return Promise.resolve(0);
      },
      print: (value) => printed.push(value),
    });
    await waitFor(() => h.text().includes("Select a command"), "后续候选没有显示");
    await h.send("\r");
    await waitFor(() => h.text().includes("Final command:"), "后续确认没有显示");
    await h.send("\r");
    assert.equal(await bounded(result), 0);
    assert.equal(executions, 1, phase);
    assert.deepEqual(printed, []);
    assert.equal(submissions, 1);
    assert.equal(h.text().includes("IGNORED"), false);
  }
});

void test("初始化遇到终端读取失败会拒绝等待并清理，不留下挂起的保存流程", async (t) => {
  const { initializeConfig } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const initialization = initializeConfig({
    cliOptions: { print: false },
    env: { HOME: "/private/tmp/unused-howto-ui-test" },
    session: h.session,
  });
  const rejected = assert.rejects(initialization, InteractiveSessionError);
  await waitFor(() => h.text().includes("Choose AI provider"), "初始化没有显示");
  h.input.emit("error", new Error("FAKE-secret"));
  await bounded(rejected);
  assert.equal(h.input.isRaw, false);
  assert.equal(h.input.listenerCount("readable"), 0);
  assert.equal(h.output.listenerCount("resize"), 0);
  assert.equal(h.text().includes("FAKE-secret"), false);
});

void test("粘贴后仍将原始命令交给执行器，不额外打印命令或手动执行说明", async (t) => {
  const { runInteractiveCommand } = await modules;
  const h = sessionHarness();
  t.after(() => h.close());
  const stdout: unknown[][] = [];
  const stderr: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => stdout.push(args));
  t.mock.method(console, "error", (...args: unknown[]) => stderr.push(args));
  const command = "printf 'A\r\nB'";
  let executed = 0;
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () =>
        Promise.resolve({
          rawText: JSON.stringify({ commands: [testCandidate(command)] }),
        }),
    },
    request: testRequest(),
    execute: (value) => {
      assert.equal(value, command);
      executed++;
      return Promise.resolve(0);
    },
  });
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  await h.send(PASTE_START + PASTE_END);
  await h.send("\r");
  await waitFor(() => h.text().includes("Final command:"), "确认没有显示");
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executed, 1);
  assert.deepEqual(stdout, []);
  assert.deepEqual(stderr, []);
  assert.ok(h.text().includes("A␍␊B"));
});

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("交互结果未在期限内完成")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
