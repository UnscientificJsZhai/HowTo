import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { createChatGptStore } from "../../src/auth/chatgpt/storage.js";

interface ChildMessage {
  event: string;
  hostId?: string;
}

interface FixtureChild {
  child: ChildProcess;
  messages: ChildMessage[];
  closed: Promise<void>;
  waitFor(event: string): Promise<ChildMessage>;
}

async function temporaryHome(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "howto-chatgpt-lock-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function startChild(t: TestContext, home: string, mode: string): FixtureChild {
  const child = fork(
    fileURLToPath(new URL("./fixtures/chatgpt-storage-child.js", import.meta.url)),
    [home, mode],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const messages: ChildMessage[] = [];
  child.on("message", (message: ChildMessage) => messages.push(message));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    assert.equal(output, "");
  });
  return {
    child,
    messages,
    closed,
    async waitFor(event) {
      const deadline = performance.now() + 8_000;
      while (performance.now() < deadline) {
        const match = messages.find((message) => message.event === event);
        if (match !== undefined) return match;
        assert.equal(
          messages.some((message) => message.event === "failed"),
          false,
        );
        if (child.exitCode !== null || child.signalCode !== null) {
          assert.fail(`fixture exited before ${event}`);
        }
        await delay(10);
      }
      assert.fail(`fixture timed out before ${event}`);
    },
  };
}

test(
  "ChatGPT 跨进程事务串行提交，首次并发初始化只生成一个 hostId",
  { timeout: 15_000 },
  async (t) => {
    const home = await temporaryHome(t);
    const first = startChild(t, home, "increment");
    const second = startChild(t, home, "increment");
    const [firstResult, secondResult] = await Promise.all([
      first.waitFor("done"),
      second.waitFor("done"),
    ]);
    await Promise.all([first.closed, second.closed]);
    assert.equal(firstResult.hostId, secondResult.hostId);
    assert.equal((await createChatGptStore(home).listAccounts())[0].generation, 2);
  },
);

test(
  "ChatGPT 锁持有者被 SIGKILL 后，等待进程可恢复且无崩溃锁文件",
  { timeout: 15_000 },
  async (t) => {
    const home = await temporaryHome(t);
    const holder = startChild(t, home, "hold");
    await holder.waitFor("entered");
    const waiter = startChild(t, home, "increment");
    await delay(100);
    assert.equal(
      waiter.messages.some((message) => message.event === "entered"),
      false,
    );
    holder.child.kill("SIGKILL");
    await holder.closed;
    await waiter.waitFor("done");
    await waiter.closed;
    assert.equal((await createChatGptStore(home).listAccounts())[0].generation, 1);
  },
);

test("ChatGPT 跨进程等待可取消，取消者不会释放另一进程的锁", { timeout: 15_000 }, async (t) => {
  const home = await temporaryHome(t);
  const holder = startChild(t, home, "hold");
  await holder.waitFor("entered");
  const cancelled = startChild(t, home, "cancel");
  await cancelled.waitFor("cancelled");
  await cancelled.closed;
  assert.equal(
    cancelled.messages.some((message) => message.event === "entered"),
    false,
  );
  const next = startChild(t, home, "increment");
  await delay(100);
  assert.equal(
    next.messages.some((message) => message.event === "entered"),
    false,
  );
  holder.child.send({ release: true });
  await holder.waitFor("done");
  await next.waitFor("done");
  await Promise.all([holder.closed, next.closed]);
  assert.equal((await createChatGptStore(home).listAccounts())[0].generation, 1);
});
