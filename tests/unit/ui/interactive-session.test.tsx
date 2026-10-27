import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInteractiveSession,
  DISABLE_PASTE,
  ENABLE_PASTE,
  InteractiveSession,
  InteractiveSessionError,
} from "../../../src/ui/interactive-session.js";
import { PASTE_END, PASTE_START } from "../../../src/ui/paste-framing.js";
import { unwrapResizeSafeOutput } from "../../../src/ui/resize-safe-output.js";
import { SessionFakeTty, sessionHarness, waitFor } from "../../helpers/interactive-session.js";

void test("分片粘贴不撤销执行权限，未结束时拒绝交接", async (t) => {
  for (const payload of ["", "safe", "\u001b[2Jbad", "未结束"]) {
    const h = sessionHarness();
    t.after(() => h.close());
    const closeView = h.session.beginView();
    const received: string[] = [];
    h.session.input.on("data", (chunk: Buffer) => {
      assert.equal(h.session.getExecutionPolicy(), "execute");
      received.push(chunk.toString());
    });
    for (const byte of Buffer.from(PASTE_START)) await h.send(Buffer.from([byte]));
    assert.equal(h.session.getExecutionPolicy(), "execute");
    await h.send(payload + (payload === "未结束" ? "" : PASTE_END));
    closeView();
    h.output.resize(1);
    h.output.resize(24);
    const closeNext = h.session.beginView();
    await h.send("\r");
    closeNext();
    assert.equal(h.session.getExecutionPolicy(), "execute");
    let executed = 0;
    if (payload === "未结束") {
      assert.throws(
        () => h.session.handoff({ execute: () => ++executed, print: () => 0 }),
        /尚未结束/,
      );
      assert.equal(executed, 0);
    } else {
      assert.equal(h.session.handoff({ execute: () => ++executed, print: () => 0 }), 1);
      assert.equal(executed, 1);
    }
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
  assert.equal(h.session.getExecutionPolicy(), "execute");
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

void test("键盘 Esc 刷新后到达的粘贴尾部整块丢弃且不撤销执行权限", async (t) => {
  const h = sessionHarness();
  t.after(() => h.close());
  h.session.beginView();
  let received = "";
  h.session.input.on("data", (chunk: Buffer) => {
    received += chunk.toString();
  });
  await h.send("\u001b");
  await waitFor(() => received === "\u001b[27u", "Esc 前缀未刷新");
  await h.send("[200~EXECUTE" + PASTE_END);
  assert.equal(h.session.getExecutionPolicy(), "execute");
  assert.equal(received, "\u001b[27u");
});

void test("Esc 刷新后的隐藏或无视图输入不会混入恢复后的键盘文本", async (t) => {
  for (const boundary of ["hidden", "view"] as const) {
    const h = sessionHarness();
    t.after(() => h.close());
    const release = h.session.beginView();
    let received = "";
    h.session.input.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    await h.send("\u001b");
    await waitFor(() => received === "\u001b[27u", "Esc 前缀未刷新");
    if (boundary === "hidden") h.output.resize(1);
    else release();
    await h.send("[2");
    if (boundary === "hidden") h.output.resize(24);
    else h.session.beginView();
    await h.send("X");
    assert.equal(received, "\u001b[27uX", boundary);
    assert.equal(h.session.getExecutionPolicy(), "execute");
  }
});

void test("待定按键后刷新 Esc 的异常走会话失败边界并恢复终端", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const prefix of ["\u001b[13;", "\u001b[1", "\u001bO"]) {
    const h = sessionHarness();
    t.after(() => h.close());
    h.session.beginView();
    const failures: Error[] = [];
    h.session.subscribeFailure((error) => failures.push(error));
    await h.send(prefix);
    await h.send("\u001b");
    assert.doesNotThrow(() => t.mock.timers.tick(20));
    assert.equal(failures.length, 1);
    assert.ok(failures[0] instanceof InteractiveSessionError);
    assert.match(failures[0].message, /按键输入序列无效/);
    assert.equal(h.session.getExecutionPolicy(), "print");
    assert.equal(h.input.isRaw, false);
    assert.equal(h.input.refs, 0);
    assert.equal(h.input.listenerCount("readable"), 0);
    assert.ok(h.bytes().toString().endsWith(DISABLE_PASTE));
    assert.throws(() =>
      h.session.handoff({ execute: () => assert.fail(), print: () => assert.fail() }),
    );
    t.mock.timers.tick(30_000);
    assert.equal(failures.length, 1);
  }
});

void test("完整按键在粘贴标记前缀的任意位置跨页或隐藏均整段丢弃", async (t) => {
  for (const sequence of [
    "\u001b[B",
    "\u001b[20~",
    "\u001b[13u",
    "\u001bOM",
    "\u001b\u001b[13u",
    "\u001b😀",
  ]) {
    const characters = [...sequence];
    for (let split = 1; split < characters.length; split++) {
      for (const boundary of ["hidden", "view"]) {
        const h = sessionHarness();
        t.after(() => h.close());
        const release = h.session.beginView();
        let received = "";
        h.session.input.on("data", (chunk: Buffer) => {
          received += chunk.toString();
        });
        await h.send(characters.slice(0, split).join(""));
        if (boundary === "hidden") {
          h.output.resize(1);
          h.output.resize(24);
        } else {
          release();
          h.session.beginView();
        }
        await h.send(characters.slice(split).join("") + "fresh\r");
        assert.equal(received, "fresh\r", `${boundary}: ${JSON.stringify(sequence)} at ${split}`);
        assert.equal(h.session.checkExecutionPolicy(), "execute");
      }
    }
  }
});

void test("隐藏或挂起期间闭合旧按键后不会超时或污染恢复后的 Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const boundary of ["hidden", "suspended"]) {
    for (const sequence of [
      "\u001b[13u",
      "\u001bOM",
      "\u001b[20~",
      "\u001b\u001b[13u",
      "\u001b😀",
    ]) {
      const h = sessionHarness();
      t.after(() => h.close());
      h.session.beginView();
      let received = "";
      h.session.input.on("data", (chunk: Buffer) => {
        received += chunk.toString();
      });
      const characters = [...sequence];
      await h.send(characters.slice(0, -1).join(""));
      if (boundary === "hidden") h.output.resize(1);
      else h.session.suspendViewInput();
      await h.send(characters.at(-1)!);
      t.mock.timers.tick(30_000);
      assert.equal(h.session.getExecutionPolicy(), "execute");
      if (boundary === "hidden") h.output.resize(24);
      else h.session.beginView();
      await h.send("\r");
      assert.equal(received, "\r");
      assert.equal(h.session.checkExecutionPolicy(), "execute");
    }
  }
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
    "paste",
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
      if (event === "execute" || event === "paste") {
        if (event === "paste") input.write(PASTE_START + PASTE_END);
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
      assert.equal(executed, event === "execute" || event === "paste" ? 1 : 0);
      assert.equal(printed, 0);
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

void test("最终同步交接拒绝恢复资源期间的未闭合粘贴与清理失败", () => {
  const h = sessionHarness();
  let executed = 0;
  h.output.on("data", (chunk: Buffer) => {
    if (chunk.toString() === DISABLE_PASTE) h.input.write(PASTE_START);
  });
  assert.equal(h.session.getExecutionPolicy(), "execute");
  assert.throws(() => h.session.handoff({ execute: () => ++executed, print: () => 0 }), /尚未结束/);
  assert.equal(executed, 0);
  assert.equal(h.session.getExecutionPolicy(), "execute");
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

void test("同步交接排空失败仍恢复资源且禁止 execute/print", () => {
  const input = new SessionFakeTty();
  const output = new SessionFakeTty();
  let released = 0;
  const session = new InteractiveSession(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
    {
      readPendingInput: () => {
        throw new Error("unavailable kernel input");
      },
      releaseInput: () => {
        released++;
      },
    },
  );
  let actions = 0;
  assert.throws(() => session.handoff({ execute: () => ++actions, print: () => ++actions }));
  assert.throws(() => session.dispose(), InteractiveSessionError);
  assert.equal(actions, 0);
  assert.equal(released, 1);
  assert.equal(input.isRaw, false);
  input.destroy();
  output.destroy();
});
