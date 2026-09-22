import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  DISABLE_PASTE,
  ENABLE_PASTE,
  InteractiveSession,
  InteractiveSessionError,
} from "../../../src/ui/interactive-session.js";
import { PASTE_START } from "../../../src/ui/paste-framing.js";
import { SessionFakeTty } from "./session-test-helpers.js";

function exitHarness(t: TestContext) {
  const input = new SessionFakeTty();
  const output = new SessionFakeTty();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const state = { registrations: 0, removals: 0, releases: 0, registered: false };
  let callback: (() => void) | undefined;
  let session: InteractiveSession | undefined;
  const resources: NonNullable<ConstructorParameters<typeof InteractiveSession>[2]> = {
    registerExit: (onExit) => {
      assert.deepEqual(input.rawChanges, []);
      assert.equal(input.refs, 0);
      assert.equal(chunks.length, 0);
      assert.equal(input.listenerCount("readable"), 0);
      state.registrations++;
      state.registered = true;
      callback = onExit;
      return () => {
        state.removals++;
        state.registered = false;
      };
    },
    releaseInput: () => {
      state.releases++;
    },
  };
  t.after(() => {
    try {
      session?.dispose();
    } finally {
      input.destroy();
      output.destroy();
    }
  });
  return {
    input,
    output,
    resources,
    state,
    bytes: () => Buffer.concat(chunks).toString(),
    create() {
      session = new InteractiveSession(
        input as unknown as NodeJS.ReadStream,
        output as unknown as NodeJS.WriteStream,
        resources,
      );
      return session;
    },
    exit() {
      assert.ok(callback, "退出钩子尚未注册");
      callback();
    },
  };
}

void test("检查通过后、终端修改前注册 alwaysLast 钩子，退出同步恢复且幂等", (t) => {
  for (const mode of ["cooked", "raw", "restore-raw"]) {
    const h = exitHarness(t);
    h.input.isRaw = mode === "raw";
    if (mode === "restore-raw") h.resources.restoreRaw = true;
    const session = h.create();
    assert.equal(h.state.registered, true);
    assert.equal(h.input.isRaw, true);
    h.exit();
    h.exit();
    session.dispose();
    assert.equal(h.input.isRaw, mode !== "cooked");
    assert.deepEqual(h.input.rawChanges, mode === "raw" ? [] : [true, mode === "restore-raw"]);
    assert.equal(h.bytes(), ENABLE_PASTE + DISABLE_PASTE);
    assert.deepEqual(h.state, { registrations: 1, removals: 1, releases: 1, registered: false });
    assert.equal(h.input.refs, 0);
    assert.equal(h.input.destroyed, false);
    assert.equal(session.input.destroyed, true);
    assert.equal(h.input.listenerCount("readable"), 0);
    assert.equal(h.output.listenerCount("resize"), 0);
  }
});

void test("输入输出检查拒绝时不注册退出钩子，也不更改终端", (t) => {
  for (const invalid of ["input", "output"]) {
    const h = exitHarness(t);
    if (invalid === "input") h.input.on("readable", () => {});
    else h.output.end();
    assert.throws(() => h.create(), InteractiveSessionError);
    assert.equal(h.state.registrations, 0);
    assert.equal(h.state.removals, 0);
    assert.equal(h.state.releases, 1);
    assert.deepEqual(h.input.rawChanges, []);
    assert.equal(h.bytes(), "");
  }
});

void test("注册或构造中途失败会回滚资源并注销已取得的钩子", (t) => {
  for (const stage of ["register", "raw", "ref", "paste"]) {
    const h = exitHarness(t);
    if (stage === "register") {
      h.resources.registerExit = () => {
        throw new Error("FAKE-secret");
      };
    }
    const setRaw = h.input.setRawMode.bind(h.input);
    h.input.setRawMode = (enabled) => {
      setRaw(enabled);
      if (enabled && stage === "raw") throw new Error("FAKE-secret");
      return h.input;
    };
    h.input.ref = () => {
      h.input.refs++;
      if (stage === "ref") throw new Error("FAKE-secret");
      return h.input;
    };
    h.output.on("data", (chunk: Buffer) => {
      if (stage === "paste" && chunk.toString() === ENABLE_PASTE) throw new Error("FAKE-secret");
    });
    assert.throws(() => h.create(), InteractiveSessionError);
    assert.equal(h.state.registered, false);
    assert.equal(h.state.removals, stage === "register" ? 0 : 1);
    assert.equal(h.state.releases, 1);
    assert.equal(h.input.isRaw, false);
    assert.equal(h.input.refs, 0);
    if (stage !== "register") h.exit();
    assert.equal(h.state.releases, 1);
  }
});

void test("正常清理和运行期间输入输出失败均注销退出钩子", (t) => {
  for (const event of ["dispose", "error", "output-error"]) {
    const h = exitHarness(t);
    const session = h.create();
    if (event === "dispose") session.dispose();
    else if (event.startsWith("output-")) h.output.emit(event.slice("output-".length));
    else h.input.emit(event);
    h.exit();
    session.dispose();
    assert.equal(h.state.removals, 1, event);
    assert.equal(h.state.releases, 1, event);
    assert.equal(h.bytes(), ENABLE_PASTE + DISABLE_PASTE);
    assert.equal(h.input.isRaw, false);
  }
});

void test("执行和仅输出交接前同步完成终端恢复与钩子注销", (t) => {
  for (const policy of ["execute", "print"]) {
    const h = exitHarness(t);
    const session = h.create();
    if (policy === "print") h.input.write(PASTE_START);
    const actions: string[] = [];
    const action = (name: string) => {
      assert.equal(h.state.registered, false);
      assert.equal(h.state.removals, 1);
      assert.equal(h.state.releases, 1);
      assert.equal(h.input.isRaw, false);
      assert.equal(h.bytes(), ENABLE_PASTE + DISABLE_PASTE);
      actions.push(name);
      return 7;
    };
    assert.equal(
      session.handoff({ execute: () => action("execute"), print: () => action("print") }),
      7,
    );
    assert.deepEqual(actions, [policy]);
    h.exit();
    assert.equal(h.state.removals, 1);
    assert.equal(h.bytes(), ENABLE_PASTE + DISABLE_PASTE);
  }
});

void test("退出回调吞掉清理异常并完成注销", (t) => {
  const h = exitHarness(t);
  h.resources.releaseInput = () => {
    throw new Error("FAKE-secret");
  };
  h.create();
  assert.doesNotThrow(() => h.exit());
  assert.equal(h.state.removals, 1);
  assert.equal(h.input.isRaw, false);
});

void test("普通清理遇到恢复异常时抛出错误并阻止执行及打印", (t) => {
  const h = exitHarness(t);
  h.resources.releaseInput = () => {
    throw new Error("FAKE-secret");
  };
  const session = h.create();
  assert.throws(() => session.dispose(), /无法恢复交互终端状态/);
  assert.throws(
    () => session.handoff({ execute: () => 7, print: () => 7 }),
    /无法恢复交互终端状态/,
  );
});

void test("输出已经关闭时，退出仍恢复 raw 并释放其余资源", (t) => {
  const h = exitHarness(t);
  h.create();
  h.output.destroy();
  assert.doesNotThrow(() => h.exit());
  assert.equal(h.input.isRaw, false);
  assert.equal(h.input.refs, 0);
  assert.equal(h.state.removals, 1);
  assert.equal(h.state.releases, 1);
  assert.equal(h.bytes(), ENABLE_PASTE);
});
