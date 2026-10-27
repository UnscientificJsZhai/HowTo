import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ChatGptStorageError,
  createChatGptStore,
  type ChatGptTransaction,
} from "../../../src/auth/chatgpt/storage.js";
import type { AccountRecord } from "../../../src/auth/chatgpt/types.js";

async function temporaryHome(t: TestContext): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "howto-chatgpt-storage-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function account(): AccountRecord {
  return {
    id: "test-account",
    label: "测试账户",
    clientId: "test-issued-client",
    issuer: "https://auth.openai.com",
    subject: "test-subject",
    email: "test@example.invalid",
    generation: 1,
    tokens: {
      accessToken: "FAKE_ACCESS_TOKEN",
      refreshToken: "FAKE_REFRESH_TOKEN",
      idToken: "FAKE_ID_TOKEN",
      scopes: ["openid", "chatgpt.tokens.use.direct"],
      expiresAt: 1_800_000_000_000,
      earliestRefreshAt: 1_799_999_940_000,
      savedAt: 1_799_999_900_000,
    },
  };
}

function storageFailure(error: unknown): boolean {
  return (
    error instanceof ChatGptStorageError &&
    error.message === "failed to access ChatGPT credentials" &&
    error.code === "storage_failed"
  );
}

test("ChatGPT 存储以私有权限保存账户，hostId 和注销后的 client 映射保持稳定", async (t) => {
  const home = await temporaryHome(t);
  const store = createChatGptStore(home);
  assert.deepEqual(await store.listAccounts(), []);
  const hostId = await store.withLock(async (transaction) => {
    const id = await transaction.getHostId();
    await transaction.save({ version: 1, accounts: [account()] });
    return id;
  });
  assert.match(hostId, /^urn:uuid:/);
  assert.deepEqual(await createChatGptStore(home).listAccounts(), [account()]);

  await store.withLock(async (transaction) => {
    const records = await transaction.read();
    records.accounts[0].generation += 1;
    delete records.accounts[0].tokens;
    await transaction.save(records);
    assert.equal(await transaction.getHostId(), hostId);
  });
  const loggedOut = (await createChatGptStore(home).listAccounts())[0];
  assert.equal(loggedOut.clientId, "test-issued-client");
  assert.equal(loggedOut.generation, 2);
  assert.equal(loggedOut.tokens, undefined);
  assert.equal(await store.withLock((transaction) => transaction.getHostId()), hostId);
  for (const path of [join(home, ".howto"), join(home, ".howto", "chatgpt")]) {
    assert.equal((await stat(path)).mode & 0o777, 0o700);
  }
  for (const name of ["host.json", "accounts.json"]) {
    assert.equal((await stat(join(home, ".howto", "chatgpt", name))).mode & 0o777, 0o600);
  }
});

test("ChatGPT 默认目录复用 HOME，拒绝相对路径", async (t) => {
  const home = await temporaryHome(t);
  const oldHome = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.deepEqual(await createChatGptStore().listAccounts(), []);
    await stat(join(home, ".howto", "chatgpt"));
    process.env.HOME = "relative-home";
    assert.throws(() => createChatGptStore(), storageFailure);
    assert.throws(() => createChatGptStore("relative-home"), storageFailure);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
});

test("ChatGPT 允许未取得 subject 的注册记录并保留刷新失败状态", async (t) => {
  const store = createChatGptStore(await temporaryHome(t));
  const pending = account();
  delete pending.tokens;
  delete pending.subject;
  pending.refreshState = "reauth_required";
  await store.withLock((transaction) => transaction.save({ version: 1, accounts: [pending] }));
  assert.deepEqual(await store.listAccounts(), [pending]);

  const refreshing = { ...account(), refreshState: "refreshing" as const };
  await store.withLock((transaction) => transaction.save({ version: 1, accounts: [refreshing] }));
  assert.deepEqual(await store.listAccounts(), [refreshing]);
});

test("ChatGPT 拒绝缺失身份的 token、非整数时间和重复账户，保留原数据", async (t) => {
  const store = createChatGptStore(await temporaryHome(t));
  await store.withLock((transaction) => transaction.save({ version: 1, accounts: [account()] }));
  const noSubject = account();
  delete noSubject.subject;
  const invalidTime = account();
  invalidTime.tokens!.expiresAt = Number.NaN;
  for (const accounts of [[noSubject], [invalidTime], [account(), account()]]) {
    await assert.rejects(
      store.withLock((transaction) => transaction.save({ version: 1, accounts })),
      storageFailure,
    );
    assert.deepEqual(await store.listAccounts(), [account()]);
  }
});

test("ChatGPT 拒绝损坏或权限开放的凭据，错误不包含文件内容", async (t) => {
  const home = await temporaryHome(t);
  const store = createChatGptStore(home);
  await store.listAccounts();
  const path = join(home, ".howto", "chatgpt", "accounts.json");
  await writeFile(path, "FAKE_SENSITIVE_BROKEN_JSON", { mode: 0o600 });
  await assert.rejects(store.listAccounts(), storageFailure);
  await writeFile(path, JSON.stringify({ version: 1, accounts: [] }));
  await chmod(path, 0o644);
  await assert.rejects(store.listAccounts(), storageFailure);
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify({ version: 999, accounts: [] }));
  await assert.rejects(store.listAccounts(), storageFailure);
});

for (const location of ["parent", "directory", "file"] as const) {
  test(`ChatGPT 拒绝 ${location} 符号链接且不修改链接目标`, async (t) => {
    const home = await temporaryHome(t);
    const outside = join(home, "outside");
    const marker = "UNCHANGED_OUTSIDE_DATA";
    if (location === "file") {
      const store = createChatGptStore(home);
      await store.listAccounts();
      await writeFile(outside, marker, { mode: 0o600 });
      await symlink(outside, join(home, ".howto", "chatgpt", "accounts.json"));
      await assert.rejects(store.listAccounts(), storageFailure);
      await assert.rejects(
        store.withLock((transaction) => transaction.save({ version: 1, accounts: [account()] })),
        storageFailure,
      );
      assert.equal(await readFile(outside, "utf8"), marker);
    } else {
      await mkdir(outside, { mode: 0o755 });
      const linkPath =
        location === "parent" ? join(home, ".howto") : join(home, ".howto", "chatgpt");
      if (location === "directory") await mkdir(join(home, ".howto"), { mode: 0o700 });
      await symlink(outside, linkPath);
      await assert.rejects(createChatGptStore(home).listAccounts(), storageFailure);
      assert.equal((await stat(outside)).mode & 0o777, 0o755);
      assert.deepEqual(await readdir(outside), []);
    }
  });
}

test("ChatGPT 拒绝硬链接凭据，防止读写与其他文件共享 inode", async (t) => {
  const home = await temporaryHome(t);
  const store = createChatGptStore(home);
  await store.listAccounts();
  const outside = join(home, "outside.json");
  const serialized = JSON.stringify({ version: 1, accounts: [account()] });
  await writeFile(outside, serialized, { mode: 0o600 });
  await link(outside, join(home, ".howto", "chatgpt", "accounts.json"));
  await assert.rejects(store.listAccounts(), storageFailure);
  await assert.rejects(
    store.withLock((transaction) => transaction.save({ version: 1, accounts: [] })),
    storageFailure,
  );
  assert.equal(await readFile(outside, "utf8"), serialized);
});

test("ChatGPT 获取锁后移除崩溃遗留临时凭据，但保留其他文件", async (t) => {
  const home = await temporaryHome(t);
  const store = createChatGptStore(home);
  await store.listAccounts();
  const directory = join(home, ".howto", "chatgpt");
  await writeFile(join(directory, `.accounts-${randomUUID()}.tmp`), "FAKE_ABANDONED_TOKEN", {
    mode: 0o600,
  });
  await writeFile(join(directory, "unrelated.txt"), "unchanged", { mode: 0o600 });
  assert.deepEqual(await store.listAccounts(), []);
  assert.deepEqual(await readdir(directory), ["unrelated.txt"]);
});

test("ChatGPT 等待锁可取消，取消原因不泄漏且不会进入事务", async (t) => {
  const home = await temporaryHome(t);
  const store = createChatGptStore(home);
  let release!: () => void;
  let entered!: () => void;
  const acquired = new Promise<void>((resolve) => (entered = resolve));
  const holding = store.withLock(async () => {
    entered();
    await new Promise<void>((resolve) => (release = resolve));
  });
  await acquired;
  const controller = new AbortController();
  let invoked = false;
  const waiting = createChatGptStore(home).withLock(() => {
    invoked = true;
    return Promise.resolve();
  }, controller.signal);
  const rejected = assert.rejects(
    waiting,
    (error: unknown) =>
      error instanceof Error &&
      error.name === "AbortError" &&
      error.message === "ChatGPT authentication cancelled",
  );
  await delay(30);
  controller.abort(new Error("FAKE_SECRET_ABORT_REASON"));
  try {
    await rejected;
    assert.equal(invoked, false);
  } finally {
    release();
    await holding;
  }
  assert.deepEqual(await store.listAccounts(), []);
});

test("ChatGPT 事务异常原样返回且释放锁，退出事务后拒绝继续读写", async (t) => {
  const store = createChatGptStore(await temporaryHome(t));
  const expected = new Error("callback failure");
  let retained!: ChatGptTransaction;
  await assert.rejects(
    store.withLock((transaction) => {
      retained = transaction;
      return Promise.reject(expected);
    }),
    (error: unknown) => error === expected,
  );
  await assert.rejects(retained.read(), storageFailure);
  await assert.rejects(retained.save({ version: 1, accounts: [] }), storageFailure);
  assert.deepEqual(await store.listAccounts(), []);
});
