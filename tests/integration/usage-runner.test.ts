import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { getEventListeners } from "node:events";
import { executeUsageLookup, resolveUsageExecutable } from "../../src/usage/runner.js";
import type { UsageLookupArguments } from "../../src/usage/types.js";

const fixture = fileURLToPath(new URL("./fixtures/usage-cli.js", import.meta.url));
const executable = resolveUsageExecutable(process.execPath)!;

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "howto-usage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function request(args: string[]): UsageLookupArguments {
  return { args, purpose: "验证本机帮助", dangerous: false, dangerReason: "" };
}

function options(args: string[]) {
  return {
    requested: request([fixture, ...args]),
    executable,
    args: [fixture, ...args],
    signal: new AbortController().signal,
    getExecutionPolicy: () => "execute" as const,
    subscribeExecutionPolicy: () => () => {},
    timeoutMs: 3_000,
  };
}

test("查询解析固定真实绝对路径，缺失程序和不可执行文件返回 null", async (t) => {
  const directory = await temporaryDirectory(t);
  const alias = join(directory, "alias");
  const notExecutable = join(directory, "plain");
  await symlink(process.execPath, alias);
  await writeFile(notExecutable, "plain data", { mode: 0o600 });
  assert.equal(resolveUsageExecutable(alias), await realpath(process.execPath));
  assert.equal(resolveUsageExecutable(join(directory, "missing")), null);
  assert.equal(resolveUsageExecutable(notExecutable), null);
});

test("查询执行多层帮助，在 cwd 内关闭 stdin 并保留 stderr 非零帮助", async () => {
  const nested = await executeUsageLookup(options(["workspace", "deployment", "--help"]));
  assert.equal(nested.status, "success");
  assert.match(nested.stdout, /workspace deployment create/);
  assert.equal(nested.exitCode, 0);
  const nonzero = await executeUsageLookup(options(["stderr-help"]));
  assert.equal(nonzero.status, "nonzero_exit");
  assert.equal(nonzero.exitCode, 3);
  assert.match(nonzero.stderr, /unusual --help/);
  assert.equal((await executeUsageLookup(options(["stdin"]))).stdout, "stdin closed\n");
  assert.equal((await executeUsageLookup(options(["cwd"]))).stdout, process.cwd());
});

test("固定真实路径执行时保留原调用名作为 argv0", async () => {
  const args = ["-e", "process.stdout.write(process.argv0)"];
  const result = await executeUsageLookup({
    ...options([]),
    requested: request(args),
    args,
    argv0: "original-tool-name",
  });
  assert.equal(result.status, "success");
  assert.equal(result.stdout, "original-tool-name");
  assert.deepEqual(result.actualCommand, { executable, args, argv0: "original-tool-name" });
});

test("编辑后的参数作为真正 argv 执行，shell 表达式、CR/LF 与空参数保持字面量", async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = join(directory, "must-not-exist");
  const actualArgs = [fixture, "echo", "", `$(touch ${marker})`, ";", ">", "x\r\ny", "a'b"];
  const result = await executeUsageLookup({ ...options(["--help"]), args: actualArgs });
  assert.equal(result.status, "success");
  assert.deepEqual(JSON.parse(result.stdout), actualArgs.slice(2));
  assert.deepEqual(result.actualCommand, { executable, args: actualArgs });
  assert.deepEqual(result.requested, request([fixture, "--help"]));
  assert.equal(existsSync(marker), false);
});

test("权限已撤销、末次同步检查撤销或事先取消时绝不启动进程", async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = join(directory, "must-not-exist");
  const prepared = options(["marker", marker]);
  const revoked = await executeUsageLookup({ ...prepared, getExecutionPolicy: () => "print" });
  assert.equal(revoked.status, "permission_revoked");
  assert.equal(revoked.actualCommand, null);
  let listener: (() => void) | undefined;
  let allowed = true;
  let checked = false;
  const drained = await executeUsageLookup({
    ...prepared,
    subscribeExecutionPolicy(callback) {
      listener = callback;
      return () => {};
    },
    getExecutionPolicy() {
      if (!checked) {
        checked = true;
        allowed = false;
        listener?.();
      }
      return allowed ? "execute" : "print";
    },
  });
  assert.equal(drained.status, "permission_revoked");
  assert.equal(drained.actualCommand, null);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeUsageLookup({ ...prepared, signal: controller.signal });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.actualCommand, null);
  assert.equal(existsSync(marker), false);
});

test("启动前同步权限复查抛错时注销全部监听器且不执行查询", async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = join(directory, "must-not-exist");
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  const failure = new Error("输入序列尚未结束");
  await assert.rejects(
    executeUsageLookup({
      ...options(["marker", marker]),
      signal: controller.signal,
      subscribeExecutionPolicy(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      getExecutionPolicy(): never {
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(listeners.size, 0);
  controller.abort();
  assert.equal(existsSync(marker), false);
});

test("参数非法、程序缺失与启动失败有明确状态且未执行命令为 null", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalid = await executeUsageLookup({ ...options([]), args: ["invalid\0"] });
  assert.equal(invalid.status, "invalid_arguments");
  assert.equal(invalid.actualCommand, null);
  const missing = await executeUsageLookup({
    ...options([]),
    executable: join(directory, "missing"),
  });
  assert.equal(missing.status, "not_found");
  assert.equal(missing.actualCommand, null);
  const missingInterpreter = join(directory, "bad-interpreter");
  await writeFile(missingInterpreter, "#!/nonexistent/howto-test-interpreter\n");
  await chmod(missingInterpreter, 0o700);
  const failed = await executeUsageLookup({ ...options([]), executable: missingInterpreter });
  assert.equal(failed.status, "spawn_failed");
  assert.equal(failed.actualCommand, null);
});

test("stdout 和 stderr 分别保留首 24 KiB 与尾 8 KiB", async () => {
  const result = await executeUsageLookup(options(["long"]));
  assert.equal(result.status, "success");
  assert.equal(result.stdout, "A".repeat(24 * 1024) + "Z".repeat(8 * 1024));
  assert.equal(result.stderr, "B".repeat(24 * 1024) + "Y".repeat(8 * 1024));
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("超时保留已有输出，500ms 后强制结束忽略 SIGTERM 的查询", { timeout: 8_000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const marker = join(directory, "pid");
  const result = await executeUsageLookup({ ...options(["wait", marker]), timeoutMs: 700 });
  const pid = Number(await readFile(marker, "utf8"));
  t.after(() => killIfAlive(pid));
  assert.equal(result.status, "timeout");
  assert.equal(result.timedOut, true);
  assert.equal(result.stdout, "partial output\n");
  await assertProcessGone(pid);
});

for (const mode of ["cancel", "revoke"] as const) {
  test(`运行时 ${mode} 清理查询并保留已有输出`, { timeout: 8_000 }, async (t) => {
    const directory = await temporaryDirectory(t);
    const marker = join(directory, "pid");
    const controller = new AbortController();
    let allowed = true;
    let listener: (() => void) | undefined;
    let unsubscribed = false;
    const running = executeUsageLookup({
      ...options(["wait", marker]),
      signal: controller.signal,
      getExecutionPolicy: () => (allowed ? "execute" : "print"),
      subscribeExecutionPolicy(callback) {
        listener = callback;
        return () => {
          unsubscribed = true;
        };
      },
    });
    await waitForFile(marker);
    const pid = Number(await readFile(marker, "utf8"));
    t.after(() => killIfAlive(pid));
    if (mode === "cancel") controller.abort();
    else {
      allowed = false;
      listener?.();
    }
    const result = await running;
    assert.equal(result.status, mode === "cancel" ? "cancelled" : "permission_revoked");
    assert.equal(result.stdout, "partial output\n");
    assert.equal(unsubscribed, true);
    await assertProcessGone(pid);
  });
}

for (const mode of ["group", "group-exit"] as const) {
  test(
    `主进程 ${mode === "group" ? "收到终止后" : "正常提前"}退出后仍清理忽略 SIGTERM 的后代`,
    { timeout: 8_000 },
    async (t) => {
      const directory = await temporaryDirectory(t);
      const marker = join(directory, "child-pid");
      const result = await executeUsageLookup({ ...options([mode, marker]), timeoutMs: 800 });
      const pid = Number(await readFile(marker, "utf8"));
      t.after(() => killIfAlive(pid));
      assert.equal(result.status, mode === "group" ? "timeout" : "success");
      assert.match(result.stdout, /parent=\d+;child=\d+/);
      await assertProcessGone(pid);
    },
  );
}

for (const mode of ["timeout", "cancel", "revoke"] as const) {
  test(
    `主进程已退出、脱离进程组的后代持有管道时 ${mode} 仍结束查询`,
    { timeout: 8_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "howto-usage-detached-"));
      const childMarker = join(directory, "child-pid");
      const parentMarker = join(directory, "parent-pid");
      // 即使回归导致查询不结束，也由测试自行清理脱离查询进程组的后代。
      t.after(async () => {
        for (const marker of [parentMarker, childMarker]) {
          if (existsSync(marker)) killIfAlive(Number(await readFile(marker, "utf8")));
        }
        await rm(directory, { recursive: true, force: true });
      });
      const controller = new AbortController();
      let allowed = true;
      let listener: (() => void) | undefined;
      let unsubscribed = false;
      const running = executeUsageLookup({
        ...options(["detached-pipes", childMarker, parentMarker]),
        signal: controller.signal,
        timeoutMs: mode === "timeout" ? 1_500 : 10_000,
        getExecutionPolicy: () => (allowed ? "execute" : "print"),
        subscribeExecutionPolicy(callback) {
          listener = callback;
          return () => {
            unsubscribed = true;
          };
        },
      });
      await waitForFile(childMarker);
      await assertProcessGone(Number(await readFile(parentMarker, "utf8")));
      const childPid = Number(await readFile(childMarker, "utf8"));
      if (mode === "cancel") controller.abort();
      else if (mode === "revoke") {
        allowed = false;
        listener?.();
      }
      const deadline = new AbortController();
      try {
        const result = await Promise.race([
          running,
          delay(3_000, undefined, { signal: deadline.signal }).then(() =>
            assert.fail("查询仍在等待脱离进程组的后代关闭管道"),
          ),
        ]);
        assert.equal(
          result.status,
          mode === "revoke" ? "permission_revoked" : mode === "cancel" ? "cancelled" : "timeout",
        );
        assert.equal(result.timedOut, mode === "timeout");
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout, "partial stdout\n");
        assert.equal(result.stderr, "partial stderr\n");
        assert.equal(unsubscribed, true);
        // 后代仍存活，证明完成不依赖它自行退出或释放 fd。
        assert.doesNotThrow(() => process.kill(childPid, 0));
      } finally {
        deadline.abort();
        killIfAlive(childPid);
        await running;
      }
    },
  );
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(path)) return;
    await delay(20);
  }
  assert.fail("test CLI did not start");
}

async function assertProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await delay(20);
  }
  assert.fail("query process was not cleaned up");
}

function killIfAlive(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 测试正常完成时进程已经退出。
  }
}
