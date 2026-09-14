import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import React from "react";
import { stripVTControlCharacters } from "node:util";
import {
  ENABLE_PASTE,
  DISABLE_PASTE,
  createInteractiveSession,
  InteractiveSession,
  InteractiveSessionError,
} from "../../../src/ui/interactive-session.js";
import { PASTE_START, PASTE_END } from "../../../src/ui/paste-framing.js";
import { unwrapResizeSafeOutput } from "../../../src/ui/resize-safe-output.js";
import { getConfigFilePath } from "../../../src/config-file.js";
import { InteractionCancelledError } from "../../../src/ui/tty.js";
import {
  sessionHarness,
  SessionFakeTty,
  waitFor,
  deferred,
  testCandidate,
  testRequest,
} from "./session-test-helpers.js";
import { importWithoutColor } from "./import-without-color.js";

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

void test("会话先读取原始开始标记，再向 Ink 桥接输入交付；权限不能恢复", async (t) => {
  for (const payload of ["", "safe", "\u001b[2Jbad", "未结束"]) {
    const h = sessionHarness();
    t.after(() => h.close());
    const closeView = h.session.beginView();
    const received: string[] = [];
    h.session.input.on("data", (chunk: Buffer) => {
      assert.equal(h.session.getExecutionPolicy(), "print");
      received.push(chunk.toString());
    });
    for (const byte of Buffer.from(PASTE_START)) await h.send(Buffer.from([byte]));
    assert.equal(h.session.getExecutionPolicy(), "print");
    await h.send(payload + (payload === "未结束" ? "" : PASTE_END));
    closeView();
    h.output.resize(1);
    h.output.resize(24);
    const closeNext = h.session.beginView();
    await h.send("\r");
    closeNext();
    assert.equal(h.session.getExecutionPolicy(), "print");
    let executed = 0;
    assert.equal(h.session.handoff({ execute: () => ++executed, print: () => 0 }), 0);
    assert.equal(executed, 0);
    assert.ok(received.every((text) => !text.includes("bad")));
  }
});

void test("UTF-8 按所有字节分片时保留中文 emoji CR LF，不误判 C1 延续字节", async (t) => {
  const h = sessionHarness();
  t.after(() => h.close());
  h.session.beginView();
  const received: Buffer[] = [];
  h.session.input.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
  const text = `${PASTE_START}中文😀👩🏽‍💻\r\n尾${PASTE_END}`;
  for (const byte of Buffer.from(text)) await h.send(Buffer.from([byte]));
  assert.equal(Buffer.concat(received).toString(), text);
  assert.equal(h.session.getExecutionPolicy(), "print");
});

void test("原始 framing 丢弃跨隐藏和无视图的整块粘贴，也排空恢复前的缓冲", async (t) => {
  const h = sessionHarness();
  t.after(() => h.close());
  let release = h.session.beginView();
  const received: Buffer[] = [];
  h.session.input.on("data", (chunk: Buffer) => received.push(Buffer.from(chunk)));
  await h.send("kept");
  await h.send(PASTE_START);
  h.output.resize(1);
  await h.send("HIDDEN");
  h.output.resize(24);
  await h.send(PASTE_END);
  await h.send(PASTE_START + "GAP");
  release();
  h.input.write("BUFFERED");
  release = h.session.beginView();
  await h.send(PASTE_END);
  await h.send(PASTE_START + "fresh" + PASTE_END);
  assert.equal(Buffer.concat(received).toString(), "kept" + PASTE_START + "fresh" + PASTE_END);
  release();
});

void test("键盘 Esc 真正刷新后到达的开始标记后缀仍撤销权限", async (t) => {
  const h = sessionHarness();
  t.after(() => h.close());
  h.session.beginView();
  let received = "";
  h.session.input.on("data", (chunk: Buffer) => {
    received += chunk.toString();
  });
  await h.send("\u001b");
  await waitFor(() => received === "\u001b", "Esc 前缀未刷新");
  await h.send("[200~EXECUTE" + PASTE_END);
  assert.equal(h.session.getExecutionPolicy(), "print");
  assert.equal(received, "\u001b");
});

void test("原始 raw 与 bracketed 租约跨卸载和重挂载连续，输出代理保留物理尺寸", () => {
  const h = sessionHarness(3, 20);
  const baselineBeforeExit = process.listenerCount("beforeExit");
  const release = h.session.beginView();
  const rawOutput = unwrapResizeSafeOutput(h.session.output);
  assert.equal(h.session.output.rows, Number.MAX_SAFE_INTEGER);
  assert.equal(rawOutput.rows, 3);
  assert.equal(rawOutput.columns, 20);
  h.output.resize(1);
  assert.equal(rawOutput.rows, 1);
  assert.equal(h.input.listenerCount("readable"), 1);
  assert.equal(h.input.listenerCount("data"), 0);
  h.session.output.write(ENABLE_PASTE);
  h.session.input.setRawMode(false);
  h.session.output.write(DISABLE_PASTE);
  release();
  assert.equal(h.input.isRaw, true);
  assert.deepEqual(h.input.rawChanges, [true]);
  assert.equal(h.bytes().toString(), ENABLE_PASTE);
  h.session.beginView()();
  h.session.dispose();
  h.session.dispose();
  assert.equal(h.bytes().toString(), ENABLE_PASTE + DISABLE_PASTE);
  assert.deepEqual(h.input.rawChanges, [true, false]);
  assert.equal(h.input.refs, 0);
  assert.equal(h.input.listenerCount("readable"), 0);
  assert.equal(h.input.listenerCount("error"), 0);
  assert.equal(h.output.listenerCount("resize"), 0);
  assert.equal(h.output.listenerCount("error"), 0);
  assert.equal(h.session.input.destroyed, true);
  assert.equal(h.input.destroyed, false);
  assert.equal(h.output.destroyed, false);
  assert.equal(process.listenerCount("beforeExit"), baselineBeforeExit);
  h.close();
});

void test("构造失败回收已经取得的资源，既有 raw 模式保持原状", () => {
  for (const failAt of ["raw", "ref", "output"]) {
    const input = new SessionFakeTty();
    const output = new SessionFakeTty();
    output.resume();
    const originalSetRaw = input.setRawMode.bind(input);
    input.setRawMode = (enabled) => {
      originalSetRaw(enabled);
      if (enabled && failAt === "raw") throw new Error("FAKE-secret");
      return input;
    };
    input.ref = () => {
      input.refs++;
      if (failAt === "ref") throw new Error("FAKE-secret");
      return input;
    };
    if (failAt === "output")
      output.on("data", () => {
        throw new Error("FAKE-secret");
      });
    assert.throws(
      () =>
        createInteractiveSession({
          input: input as unknown as NodeJS.ReadStream,
          output: output as unknown as NodeJS.WriteStream,
        }),
      (error: Error) =>
        error instanceof InteractiveSessionError && !error.message.includes("FAKE-secret"),
    );
    assert.equal(input.isRaw, false);
    assert.equal(input.refs, 0);
    assert.equal(input.listenerCount("readable"), 0);
    assert.equal(input.listenerCount("error"), 0);
    assert.equal(output.listenerCount("resize"), 0);
    assert.equal(output.listenerCount("error"), 0);
    input.destroy();
    output.destroy();
  }
  const input = new SessionFakeTty();
  const output = new SessionFakeTty();
  input.isRaw = true;
  output.resume();
  const session = createInteractiveSession({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  session.dispose();
  assert.deepEqual(input.rawChanges, []);
  assert.equal(input.isRaw, true);
  assert.equal(input.refs, 0);
  input.destroy();
  output.destroy();
});

void test("构造器拒绝接管时保留原消费者的监听、缓冲和终端状态", () => {
  for (const event of ["readable", "data", "invalid-output"] as const) {
    const input = new SessionFakeTty();
    const output = new SessionFakeTty();
    const owner = () => {};
    if (event === "invalid-output") output.end();
    else input.on(event, owner);
    input.pause();
    input.write("original-owner-buffer");
    const encoding = input.readableEncoding;
    try {
      assert.throws(
        () =>
          createInteractiveSession({
            input: input as unknown as NodeJS.ReadStream,
            output: output as unknown as NodeJS.WriteStream,
          }),
        InteractiveSessionError,
      );
      if (event !== "invalid-output") assert.deepEqual(input.listeners(event), [owner]);
      assert.equal(input.readableLength, 21);
      assert.equal((input.read() as Buffer).toString(), "original-owner-buffer");
      assert.deepEqual(input.rawChanges, []);
      assert.equal(input.refs, 0);
      assert.equal(input.readableEncoding, encoding);
      assert.equal(input.destroyed, false);
    } finally {
      input.destroy();
      output.destroy();
    }
  }
});

void test("内部冷 stdin 工厂在可观察输入已用或 fd 非零时拒绝创建读者", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  assert.ok(descriptor);
  for (const state of ["fd", "flowing", "history", "buffer"]) {
    const input = Object.assign(new SessionFakeTty(), { fd: state === "fd" ? 7 : 0 });
    const output = new SessionFakeTty();
    if (state === "flowing") input.pause();
    if (state === "history") {
      input.write("previous-input");
      input.read();
    }
    if (state === "buffer") input.write("owner-buffer");
    const length = input.readableLength;
    const originalRead = input.read.bind(input);
    let reads = 0;
    input.read = (size) => {
      reads++;
      return originalRead(size) as Buffer | null;
    };
    try {
      // 同步范围内注入 fake TTY，避免测试读取真实 fd 或改动调用者终端。
      Object.defineProperty(process, "stdin", { configurable: true, value: input });
      assert.throws(
        () =>
          createInteractiveSession({
            input: input as unknown as NodeJS.ReadStream,
            output: output as unknown as NodeJS.WriteStream,
          }),
        InteractiveSessionError,
      );
      assert.equal(reads, 0, state);
      assert.equal(input.readableLength, length);
      assert.deepEqual(input.rawChanges, []);
      assert.equal(input.refs, 0);
      assert.equal(input.destroyed, false);
    } finally {
      Object.defineProperty(process, "stdin", descriptor);
      input.destroy();
      output.destroy();
    }
  }
});

void test("自有读者在输出、执行、取消和终端失败后只释放一次", () => {
  for (const event of [
    "dispose",
    "execute",
    "print",
    "error",
    "end",
    "close",
    "output-error",
    "output-close",
    "output-finish",
  ]) {
    const input = new SessionFakeTty();
    const output = new SessionFakeTty();
    output.resume();
    let releases = 0;
    const session = new InteractiveSession(
      input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream,
      {
        releaseInput: () => {
          releases++;
          input.destroy();
        },
      },
    );
    let executed = 0;
    let printed = 0;
    try {
      if (event === "execute" || event === "print") {
        if (event === "print") input.write(PASTE_START);
        session.handoff({ execute: () => ++executed, print: () => ++printed });
      } else if (event === "dispose") session.dispose();
      else if (event.startsWith("output-")) output.emit(event.slice("output-".length));
      else input.emit(event);
      session.dispose();
      session.dispose();
      assert.equal(releases, 1, event);
      assert.equal(input.destroyed, true);
      assert.equal(input.listenerCount("readable"), 0);
      assert.equal(output.listenerCount("resize"), 0);
      assert.equal(input.refs, 0);
      assert.equal(executed, event === "execute" ? 1 : 0);
      assert.equal(printed, event === "print" ? 1 : 0);
    } finally {
      session.dispose();
      input.destroy();
      output.destroy();
    }
  }
});

void test("自有读者构造中途失败也释放，原 raw 恢复目标与新读者初始模式分离", () => {
  for (const stage of ["input", "raw", "ref", "output"]) {
    const input = new SessionFakeTty();
    const output = new SessionFakeTty();
    output.resume();
    let releases = 0;
    const originalSetRaw = input.setRawMode.bind(input);
    input.setRawMode = (enabled) => {
      originalSetRaw(enabled);
      if (stage === "raw" && enabled) throw new Error("FAKE-secret");
      return input;
    };
    input.ref = () => {
      input.refs++;
      if (stage === "ref") throw new Error("FAKE-secret");
      return input;
    };
    if (stage === "input") input.on("readable", () => {});
    if (stage === "output")
      output.on("data", () => {
        throw new Error("FAKE-secret");
      });
    try {
      assert.throws(
        () =>
          new InteractiveSession(
            input as unknown as NodeJS.ReadStream,
            output as unknown as NodeJS.WriteStream,
            {
              releaseInput: () => {
                releases++;
                input.destroy();
              },
            },
          ),
        InteractiveSessionError,
      );
      assert.equal(releases, 1, stage);
      assert.equal(input.destroyed, true);
      assert.equal(input.refs, 0);
      assert.equal(input.isRaw, false);
    } finally {
      input.destroy();
      output.destroy();
    }
  }
  const input = new SessionFakeTty();
  const output = new SessionFakeTty();
  output.resume();
  const session = new InteractiveSession(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
    { restoreRaw: true, releaseInput: () => input.destroy() },
  );
  session.dispose();
  assert.deepEqual(input.rawChanges, [true, true]);
  assert.equal(input.isRaw, true);
  assert.equal(input.refs, 0);
  output.destroy();
});

void test("自有读者的同步释放失败不会到达执行器，重复清理不重复释放", () => {
  const input = new SessionFakeTty();
  const output = new SessionFakeTty();
  output.resume();
  let releases = 0;
  let executions = 0;
  const session = new InteractiveSession(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
    {
      releaseInput: () => {
        releases++;
        input.destroy();
        throw new Error("FAKE-secret");
      },
    },
  );
  try {
    assert.throws(
      () => session.handoff({ execute: () => ++executions, print: () => 0 }),
      /无法恢复交互终端状态/,
    );
    session.dispose();
    assert.equal(executions, 0);
    assert.equal(releases, 1);
  } finally {
    output.destroy();
  }
});

void test("清理中 destroy 的异步 error 在关闭前被接收，任何模式都不进入动作", () => {
  const moduleUrl = new URL("../../../src/ui/interactive-session.js", import.meta.url).href;
  const framingUrl = new URL("../../../src/ui/paste-framing.js", import.meta.url).href;
  const script = `
    import { PassThrough } from 'node:stream';
    import { setImmediate as nextTurn } from 'node:timers/promises';
    import { createInteractiveSession, DISABLE_PASTE } from ${JSON.stringify(moduleUrl)};
    import { PASTE_START } from ${JSON.stringify(framingUrl)};
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
        if (policy === 'print') input.write(PASTE_START);
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
      execute: () => Promise.resolve(++executions),
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

void test("资源获取同步 emit error 后正常返回时不再 ref 或重新开启粘贴模式", () => {
  for (const stage of ["raw", "ref", "output"]) {
    const input = new SessionFakeTty();
    const output = new SessionFakeTty();
    const writes: string[] = [];
    let failureEvents = 0;
    output.on("data", (chunk: Buffer) => {
      writes.push(chunk.toString());
      if (stage === "output" && chunk.toString() === ENABLE_PASTE) {
        failureEvents++;
        output.emit("error", new Error("FAKE-secret"));
      }
    });
    const setRaw = input.setRawMode.bind(input);
    input.setRawMode = (enabled) => {
      setRaw(enabled);
      if (stage === "raw" && enabled) {
        failureEvents++;
        input.emit("error", new Error("FAKE-secret"));
      }
      return input;
    };
    input.ref = () => {
      input.refs++;
      if (stage === "ref") {
        failureEvents++;
        input.emit("error", new Error("FAKE-secret"));
      }
      return input;
    };
    try {
      assert.throws(
        () =>
          createInteractiveSession({
            input: input as unknown as NodeJS.ReadStream,
            output: output as unknown as NodeJS.WriteStream,
          }),
        InteractiveSessionError,
      );
      assert.equal(failureEvents, 1);
      assert.equal(input.refs, 0, stage);
      assert.equal(input.isRaw, false);
      assert.deepEqual(writes, stage === "output" ? [ENABLE_PASTE, DISABLE_PASTE] : [], stage);
      assert.equal(input.listenerCount("error"), 0);
      assert.equal(output.listenerCount("error"), 0);
    } finally {
      input.destroy();
      output.destroy();
    }
  }
});

void test("最终同步交接在恢复资源后再次读取权限，清理失败也绝不调用执行器", () => {
  const h = sessionHarness();
  let executed = 0;
  h.output.on("data", (chunk: Buffer) => {
    if (chunk.toString() === DISABLE_PASTE) h.input.write(PASTE_START);
  });
  assert.equal(h.session.getExecutionPolicy(), "execute");
  assert.equal(h.session.handoff({ execute: () => ++executed, print: () => 0 }), 0);
  assert.equal(executed, 0);
  assert.equal(h.session.getExecutionPolicy(), "print");
  h.close();

  const failing = sessionHarness();
  const original = failing.input.setRawMode.bind(failing.input);
  failing.input.setRawMode = (enabled) => {
    original(enabled);
    if (!enabled) throw new Error("FAKE-secret");
    return failing.input;
  };
  assert.throws(
    () => failing.session.handoff({ execute: () => ++executed, print: () => 0 }),
    /无法恢复交互终端状态/,
  );
  assert.equal(executed, 0);
  assert.equal(failing.input.listenerCount("readable"), 0);
  assert.equal(failing.input.refs, 0);
  failing.close();
});

void test("卸载后恢复 raw 和 ref 期间到达的分片粘贴在真实最外层仍只能输出", async (t) => {
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
    execute: () => Promise.resolve(++executions),
    print: (command) => printed.push(command),
  });
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("Final command:"), "最终确认没有显示");
  assert.equal(h.session.getExecutionPolicy(), "execute");
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executions, 0);
  assert.deepEqual(printed, [testCandidate().command]);
  assert.equal(h.session.getExecutionPolicy(), "print");
});

void test("真实最外层调度保持纯键盘普通和危险确认行为，取消始终不执行", async (t) => {
  const { runInteractiveCommand } = await modules;
  for (const scenario of [
    { command: "printf session-safe", keys: "\r", executed: 1 },
    { command: "rm -rf /private/tmp/FAKE-not-executed", keys: "EXECUTE\r", executed: 1 },
    { command: "rm -rf /private/tmp/FAKE-not-executed", keys: "WRONG\r", executed: 0 },
    { command: "printf session-safe", keys: "\u001b", executed: 0 },
    { command: "printf session-safe", keys: "\u0003", executed: 0 },
    ...[
      "brew rm example-package",
      "brew uninstal example-package",
      "yum -y update",
      "yum -y erase example-package",
      "dnf -y update",
      "dnf -y erase example-package",
    ].flatMap((command) => [
      { command, keys: "\r", executed: 0 },
      { command, keys: "EXECUTE\r", executed: 1 },
    ]),
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

void test("伪结束第一片先完成 UI 时最外层 execute 仍为零，外层结束未到也只能输出", async (t) => {
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
    execute: () => Promise.resolve(++executions),
    print: (value) => printed.push(value),
  });
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  await h.send("\r");
  await waitFor(() => h.text().includes("EXECUTE+Enter"), "危险确认没有显示");
  await h.send(PASTE_START + "EXECUTE" + PASTE_END + "\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executions, 0);
  assert.deepEqual(printed, [command]);
  h.input.write(PASTE_END + "EXECUTE\r\r");
  assert.equal(h.session.getExecutionPolicy(), "print");
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
      execute: () => Promise.resolve(++executions),
      print: (value) => printed.push(value),
    });
    await waitFor(() => h.text().includes("Thinking"), "loading 没有显示");
    if (phase === "hidden") h.output.resize(1);
    if (phase !== "unmount") await h.send(PASTE_START + PASTE_END);
    if (phase === "hidden") h.output.resize(24);
    provider.resolve({ rawText: JSON.stringify({ commands: [testCandidate()] }) });
    await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
    await h.send("\r");
    await waitFor(
      () => h.text().includes(phase === "unmount" ? "Final command:" : "仅输出:"),
      "确认没有显示",
    );
    if (phase === "unmount") {
      assert.equal(h.session.getExecutionPolicy(), "execute");
      h.output.on("data", (chunk: Buffer) => {
        if (chunk.includes(Buffer.from("\u001b[?25h"))) h.input.write(PASTE_START);
      });
    }
    await h.send("\r");
    assert.equal(await bounded(result), 0);
    assert.equal(executions, 0, phase);
    assert.deepEqual(printed, [testCandidate().command]);
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
      execute: () => Promise.resolve(++executions),
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

void test("自动初始化与 App 共用同一原始租约，独立初始化粘贴也可保存一次", async (t) => {
  const { initializeConfig, runInteractiveCommand } = await modules;
  const home = await mkdtemp("/private/tmp/howto-ui-init-test-");
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
  assert.equal(h.session.getExecutionPolicy(), "print");
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
    execute: () => Promise.resolve(++executions),
    print: (value) => printed.push(value),
  });
  await waitFor(() => h.text().includes("Select a command"), "初始化后候选没有显示");
  await h.send(PASTE_END);
  await h.send("\r");
  await waitFor(() => h.text().includes("Enter输出 Esc取消"), "仅输出确认没有显示");
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executions, 0);
  assert.deepEqual(printed, [testCandidate().command]);
  assert.deepEqual(h.input.rawChanges, [true, false]);
});

void test("仅输出布局在物理 2 3 4 24 行保留当前动作，0 1 行不接受确认", async (t) => {
  const { render, ConfirmView, InteractiveSessionProvider } = await modules;
  for (const rows of [0, 1, 2, 3, 4, 24]) {
    const h = sessionHarness(rows, 20);
    t.after(() => h.close());
    await h.send(PASTE_START + PASTE_END);
    let confirmed = 0;
    const offset = h.bytes().length;
    const instance = render(
      <InteractiveSessionProvider session={h.session}>
        <ConfirmView
          candidate={testCandidate()}
          command="printf abcdefghijklmnopqrstuvwxyz"
          resolvedValues={new Map()}
          availableRows={Math.max(0, rows - 1)}
          availableColumns={20}
          onConfirm={() => confirmed++}
          onCancel={() => {}}
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
    const visible = stripVTControlCharacters(h.bytes().subarray(offset).toString()).trimEnd();
    if (rows <= 1) assert.equal(visible, "");
    else {
      assert.ok(visible.includes("仅输出:"));
      assert.ok(visible.includes(rows === 2 ? " Ent Esc" : "Enter输出 Esc取消"));
      assert.ok(visible.split("\n").length <= rows - 1);
    }
    await h.send("\r");
    await instance.waitUntilRenderFlush();
    assert.equal(confirmed, rows <= 1 ? 0 : 1);
    instance.unmount();
    await instance.waitUntilExit();
    h.session.dispose();
    assert.ok(!h.bytes().includes(Buffer.from("\u001b[2J")));
    assert.ok(!h.bytes().includes(Buffer.from("\u001b[3J")));
    assert.ok(!h.bytes().includes(Buffer.from("\u001b[H")));
  }
});

void test("隐藏粘贴经过真实 App 后只输出既有占位符值，初始化也不保存隐藏片段", async (t) => {
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
    execute: () => Promise.resolve(++executions),
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
  await waitFor(() => h.text().includes("Enter输出 Esc取消"), "输出确认没有显示");
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executions, 0);
  assert.deepEqual(printed, ["printf kept"]);
  assert.equal(h.text().includes("HIDDEN"), false);

  const home = await mkdtemp("/private/tmp/howto-ui-hidden-init-");
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

void test("保存中和初始化卸载空隙首次收到粘贴时同样撤销后续 App 的执行权限", async (t) => {
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
      execute: () => Promise.resolve(++executions),
      print: (value) => printed.push(value),
    });
    await waitFor(() => h.text().includes("Select a command"), "后续候选没有显示");
    await h.send("\r");
    await waitFor(() => h.text().includes("Enter输出 Esc取消"), "后续确认没有显示");
    await h.send("\r");
    assert.equal(await bounded(result), 0);
    assert.equal(executions, 0, phase);
    assert.deepEqual(printed, [testCandidate().command]);
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

void test("默认输出出口将原始命令写到 stdout、固定说明写到 stderr，返回零", async (t) => {
  const { runInteractiveCommand, MANUAL_EXECUTION_NOTICE } = await modules;
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
    execute: () => Promise.resolve(++executed),
  });
  await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
  await h.send(PASTE_START + PASTE_END);
  await h.send("\r");
  await waitFor(() => h.text().includes("Enter输出 Esc取消"), "确认没有显示");
  await h.send("\r");
  assert.equal(await bounded(result), 0);
  assert.equal(executed, 0);
  assert.deepEqual(stdout, [[command]]);
  assert.deepEqual(stderr, [[MANUAL_EXECUTION_NOTICE]]);
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
