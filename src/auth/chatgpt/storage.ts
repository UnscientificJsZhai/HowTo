import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getConfigFilePath } from "../../config-file.js";
import type { AccountRecord, AccountStore, ChatGptTokens, HostRecord } from "./types.js";

const MAX_FILE_BYTES = 1_048_576;
const LOCK_TIMEOUT_MS = 35_000;
const TEMPORARY_FILE = /^\.(?:host|accounts)-[0-9a-f-]{36}\.tmp$/;

export class ChatGptStorageError extends Error {
  readonly code: "storage_failed" | "lock_timeout";

  constructor(code: "storage_failed" | "lock_timeout" = "storage_failed") {
    super("failed to access ChatGPT credentials");
    this.name = "ChatGptStorageError";
    this.code = code;
  }
}

export interface ChatGptTransaction {
  /** 此存储预留的互斥端口，不能用于长时间等待的 OAuth 回调监听。 */
  readonly lockPort: number;
  read(): Promise<AccountStore>;
  save(store: AccountStore): Promise<void>;
  getHostId(): Promise<string>;
}

export interface ChatGptStore {
  listAccounts(signal?: AbortSignal): Promise<AccountRecord[]>;
  withLock<T>(
    fn: (transaction: ChatGptTransaction) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

interface PrivateDirectory {
  path: string;
  parentPath: string;
  parentIdentity: Stats;
  identity: Stats;
  handle: FileHandle;
  uid: number;
}

export function createChatGptStore(homeDirectory?: string): ChatGptStore {
  let home: string;
  try {
    home = homeDirectory ?? dirname(dirname(getConfigFilePath()));
    if (!isAbsolute(home)) throw new ChatGptStorageError();
  } catch {
    throw new ChatGptStorageError();
  }

  const store: ChatGptStore = {
    async listAccounts(signal) {
      return store.withLock(async (transaction) => (await transaction.read()).accounts, signal);
    },
    async withLock(fn, signal) {
      throwIfAborted(signal);
      const directory = await protectStorageErrors(() => prepareDirectory(home));
      let lock: Server | undefined;
      let active = true;
      let pending: Promise<void> = Promise.resolve();
      const run = <T>(operation: () => Promise<T>): Promise<T> => {
        if (!active) return Promise.reject(new ChatGptStorageError());
        const result = pending.then(() => protectStorageErrors(operation));
        pending = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };
      try {
        lock = await acquireLock(directory, signal);
        throwIfAborted(signal);
        await protectStorageErrors(async () => {
          await assertDirectoryUnchanged(directory);
          await removeAbandonedWrites(directory);
        });
        const lockAddress = lock.address();
        if (lockAddress === null || typeof lockAddress === "string")
          throw new ChatGptStorageError();
        const transaction: ChatGptTransaction = {
          lockPort: lockAddress.port,
          read: () => run(() => readAccounts(directory)),
          save: (value) =>
            run(async () => {
              const validated = parseAccountStore(value);
              await writeRecord(directory, "accounts", validated);
            }),
          getHostId: () =>
            run(async () => {
              const record = await readRecord(directory, "host");
              if (record !== undefined) return parseHostRecord(record).hostId;
              const host: HostRecord = { version: 1, hostId: `urn:uuid:${randomUUID()}` };
              await writeRecord(directory, "host", host);
              return host.hostId;
            }),
        };
        // 持锁后的取消由调用方处理；凭据提交不能因取消而被中途释放锁。
        return await fn(transaction);
      } finally {
        active = false;
        // 即使调用方漏掉 await，也必须等已开始的文件操作结束后再释放锁。
        await pending;
        if (lock !== undefined) await closeLock(lock);
        await directory.handle.close().catch(() => undefined);
      }
    },
  };
  return store;
}

async function prepareDirectory(home: string): Promise<PrivateDirectory> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new ChatGptStorageError();
  const homeIdentity = await lstat(home);
  if (
    !homeIdentity.isDirectory() ||
    homeIdentity.uid !== uid ||
    (homeIdentity.mode & 0o022) !== 0
  ) {
    throw new ChatGptStorageError();
  }
  const canonicalHome = await realpath(home);
  const parentPath = join(canonicalHome, ".howto");
  const parent = await openPrivateDirectory(parentPath, uid);
  try {
    const parentIdentity = await parent.stat();
    const path = join(parentPath, "chatgpt");
    const handle = await openPrivateDirectory(path, uid);
    try {
      const directory = {
        path,
        parentPath,
        parentIdentity,
        identity: await handle.stat(),
        handle,
        uid,
      };
      await assertDirectoryUnchanged(directory);
      return directory;
    } catch (error) {
      await handle.close();
      throw error;
    }
  } finally {
    await parent.close();
  }
}

async function openPrivateDirectory(path: string, uid: number): Promise<FileHandle> {
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!hasCode(error, "EEXIST")) throw error;
  });
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const identity = await handle.stat();
    if (!identity.isDirectory() || identity.uid !== uid) throw new ChatGptStorageError();
    await handle.chmod(0o700);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertDirectoryUnchanged(directory: PrivateDirectory): Promise<void> {
  const parent = await lstat(directory.parentPath);
  const current = await lstat(directory.path);
  for (const [actual, expected] of [
    [parent, directory.parentIdentity],
    [current, directory.identity],
  ]) {
    if (
      !actual.isDirectory() ||
      actual.uid !== directory.uid ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino ||
      (actual.mode & 0o777) !== 0o700
    ) {
      throw new ChatGptStorageError();
    }
  }
}

async function acquireLock(directory: PrivateDirectory, signal?: AbortSignal): Promise<Server> {
  // 内核监听锁在进程退出时自动释放；不按时间抢占活跃刷新，也没有 PID 文件重收竞态。
  // 同一目录固定使用同一端口。碰撞时只等待/失败，绝不换端口绕过互斥。
  const key = `${directory.uid}:${directory.identity.dev}:${directory.identity.ino}`;
  const port = 16_384 + (createHash("sha256").update(key).digest().readUInt32BE(0) % 49_152);
  const startedAt = performance.now();
  while (true) {
    throwIfAborted(signal);
    const server = await protectStorageErrors(() => tryListen(port));
    if (server !== undefined) return server;
    if (performance.now() - startedAt >= LOCK_TIMEOUT_MS) {
      throw new ChatGptStorageError("lock_timeout");
    }
    try {
      await delay(50, undefined, { signal });
    } catch {
      throwIfAborted(signal);
      throw new ChatGptStorageError();
    }
  }
}

function tryListen(port: number): Promise<Server | undefined> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (error: Error) => {
      if (hasCode(error, "EADDRINUSE")) resolve(undefined);
      else reject(error);
    });
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve(server));
  });
}

function closeLock(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readAccounts(directory: PrivateDirectory): Promise<AccountStore> {
  const record = await readRecord(directory, "accounts");
  return record === undefined ? { version: 1, accounts: [] } : parseAccountStore(record);
}

async function readRecord(
  directory: PrivateDirectory,
  name: "host" | "accounts",
): Promise<unknown> {
  await assertDirectoryUnchanged(directory);
  let handle: FileHandle;
  try {
    handle = await open(
      join(directory.path, `${name}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    assertPrivateFile(await handle.stat(), directory.uid);
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new ChatGptStorageError();
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

function assertPrivateFile(identity: Stats, uid: number): void {
  if (
    !identity.isFile() ||
    identity.uid !== uid ||
    identity.nlink !== 1 ||
    (identity.mode & 0o777) !== 0o600 ||
    identity.size > MAX_FILE_BYTES
  ) {
    throw new ChatGptStorageError();
  }
}

async function writeRecord(
  directory: PrivateDirectory,
  name: "host" | "accounts",
  value: HostRecord | AccountStore,
): Promise<void> {
  await assertDirectoryUnchanged(directory);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_FILE_BYTES) throw new ChatGptStorageError();
  const temporary = join(directory.path, `.${name}-${randomUUID()}.tmp`);
  const target = join(directory.path, `${name}.json`);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await assertDirectoryUnchanged(directory);
    await lstat(target)
      .then((identity) => assertPrivateFile(identity, directory.uid))
      .catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    await rename(temporary, target);
    await directory.handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function removeAbandonedWrites(directory: PrivateDirectory): Promise<void> {
  for (const name of await readdir(directory.path)) {
    if (!TEMPORARY_FILE.test(name)) continue;
    const path = join(directory.path, name);
    assertPrivateFile(await lstat(path), directory.uid);
    await unlink(path);
  }
}

function parseHostRecord(value: unknown): HostRecord {
  const record = asObject(value);
  if (record.version !== 1) throw new ChatGptStorageError();
  return { version: 1, hostId: nonEmptyString(record.hostId) };
}

function parseAccountStore(value: unknown): AccountStore {
  const record = asObject(value);
  if (record.version !== 1 || !Array.isArray(record.accounts)) throw new ChatGptStorageError();
  const accounts = record.accounts.map(parseAccount);
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
    throw new ChatGptStorageError();
  }
  return { version: 1, accounts };
}

function parseAccount(value: unknown): AccountRecord {
  const record = asObject(value);
  if (record.issuer !== "https://auth.openai.com") throw new ChatGptStorageError();
  const account: AccountRecord = {
    id: nonEmptyString(record.id),
    label: nonEmptyString(record.label),
    clientId: nonEmptyString(record.clientId),
    issuer: record.issuer,
    generation: timestamp(record.generation),
  };
  if (record.subject !== undefined) account.subject = nonEmptyString(record.subject);
  if (record.email !== undefined) account.email = nonEmptyString(record.email);
  if (record.refreshState !== undefined) {
    if (record.refreshState !== "refreshing" && record.refreshState !== "reauth_required") {
      throw new ChatGptStorageError();
    }
    account.refreshState = record.refreshState;
  }
  if (record.tokens !== undefined) {
    if (account.subject === undefined) throw new ChatGptStorageError();
    account.tokens = parseTokens(record.tokens);
  }
  return account;
}

function parseTokens(value: unknown): ChatGptTokens {
  const record = asObject(value);
  if (!Array.isArray(record.scopes)) throw new ChatGptStorageError();
  const tokens: ChatGptTokens = {
    accessToken: nonEmptyString(record.accessToken),
    idToken: nonEmptyString(record.idToken),
    scopes: record.scopes.map(nonEmptyString),
    expiresAt: timestamp(record.expiresAt),
    savedAt: timestamp(record.savedAt),
  };
  if (record.refreshToken !== undefined) tokens.refreshToken = nonEmptyString(record.refreshToken);
  if (record.earliestRefreshAt !== undefined) {
    tokens.earliestRefreshAt = timestamp(record.earliestRefreshAt);
  }
  return tokens;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChatGptStorageError();
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new ChatGptStorageError();
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ChatGptStorageError();
  }
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT authentication cancelled", "AbortError");
}

async function protectStorageErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ChatGptStorageError) throw error;
    throw new ChatGptStorageError();
  }
}
