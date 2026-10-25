import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:net";
import fs, { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  getChatGptAccessToken,
  listChatGptAccounts,
  loginChatGpt,
  logoutChatGpt,
} from "../../src/auth/chatgpt/index.js";
import { ChatGptError } from "../../src/auth/chatgpt/errors.js";
import { CHATGPT_ISSUER, CHATGPT_RESOURCE } from "../../src/auth/chatgpt/http.js";
import { createChatGptStore } from "../../src/auth/chatgpt/storage.js";
import { InteractionCancelledError } from "../../src/ui/tty.js";

const metadata = {
  issuer: CHATGPT_ISSUER,
  authorization_endpoint: `${CHATGPT_ISSUER}/api/accounts/authorize`,
  token_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/token`,
  revocation_endpoint: `${CHATGPT_ISSUER}/api/accounts/oauth/revoke`,
  jwks_uri: `${CHATGPT_ISSUER}/.well-known/jwks.json`,
};

async function fixture() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "howto-auth-"));
  const key = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(key.publicKey)), kid: "test-key", alg: "ES256" };
  const clientId = "oaiapp_test_registration";
  let authorization: URL | undefined;
  let subject = "test-subject";
  let nonceOverride: string | undefined;
  let scope = "openid email profile offline_access resource.invoke chatgpt.tokens.use.direct";
  let callbackError = false;
  let callbackClientOverride: string | undefined;
  let tokenCalls = 0;
  let refreshCalls = 0;
  let refreshFailure: string | undefined;
  let revokeFailure = false;
  let identityExpiry: "valid" | "expired" | "missing" = "valid";
  const manualUrls: string[] = [];
  const requests: { url: string; body: URLSearchParams }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : undefined);
    requests.push({ url, body });
    assert.equal(init?.redirect, "error");
    if (url.endsWith("/.well-known/openid-configuration")) return Response.json(metadata);
    if (url === metadata.jwks_uri) return Response.json({ keys: [jwk] });
    if (url === metadata.revocation_endpoint) {
      assert.equal(body.get("client_id"), clientId);
      assert.equal(body.get("token_type_hint"), "refresh_token");
      assert.ok(body.get("token")?.startsWith("refresh-"));
      return new Response(null, { status: revokeFailure ? 503 : 200 });
    }
    assert.equal(url, metadata.token_endpoint);
    assert.equal(body.get("client_id"), clientId);
    assert.equal(body.get("resource"), CHATGPT_RESOURCE);
    tokenCalls += 1;
    if (body.get("grant_type") === "refresh_token") {
      refreshCalls += 1;
      assert.equal(body.has("scope"), false);
      if (refreshFailure === "network") throw new Error("secret upstream detail");
      if (refreshFailure !== undefined)
        return Response.json(
          { error: refreshFailure },
          { status: refreshFailure === "invalid_grant" ? 400 : 503 },
        );
    } else {
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("redirect_uri"), authorization?.searchParams.get("redirect_uri"));
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url"),
        authorization?.searchParams.get("code_challenge"),
      );
    }
    const signedIdentity = new SignJWT({
      nonce: nonceOverride ?? authorization?.searchParams.get("nonce"),
      email: "person@example.test",
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(CHATGPT_ISSUER)
      .setAudience(clientId)
      .setSubject(subject)
      .setIssuedAt();
    if (identityExpiry !== "missing")
      signedIdentity.setExpirationTime(identityExpiry === "expired" ? "-1s" : "1h");
    const idToken = await signedIdentity.sign(key.privateKey);
    return Response.json({
      access_token: `access-${tokenCalls}`,
      refresh_token: `refresh-${tokenCalls}`,
      id_token: idToken,
      token_type: "Bearer",
      expires_in: 3600,
      scope,
    });
  };
  const openBrowser = async (url: string) => {
    authorization = new URL(url);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.pathname, "/auth/callback");
    const malformedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        { hostname: "127.0.0.1", port: callback.port, path: "//" },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end();
    });
    assert.equal(malformedStatus, 400);
    callback.searchParams.set("state", "incorrect-state");
    assert.equal((await fetch(callback)).status, 400);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    if (callbackError) callback.searchParams.set("error", "access_denied");
    else {
      callback.searchParams.set("code", "single-use-code");
      callback.searchParams.set("client_id", callbackClientOverride ?? clientId);
    }
    const response = await fetch(callback);
    await response.text();
    return true;
  };
  const dependencies = { homeDirectory, fetch: fetcher, openBrowser };
  return {
    dependencies,
    completeAuthorization: openBrowser,
    requests,
    manualUrls,
    clientId,
    store: createChatGptStore(homeDirectory),
    login: (accountId?: string) =>
      loginChatGpt({ accountId, onAuthorizationUrl: (url) => manualUrls.push(url) }, dependencies),
    get authorization() {
      return authorization!;
    },
    get tokenCalls() {
      return tokenCalls;
    },
    get refreshCalls() {
      return refreshCalls;
    },
    setSubject(value: string) {
      subject = value;
    },
    setNonce(value: string) {
      nonceOverride = value;
    },
    setScope(value: string) {
      scope = value;
    },
    setCallbackError() {
      callbackError = true;
    },
    setCallbackClient(value: string) {
      callbackClientOverride = value;
    },
    setRefreshFailure(value?: string) {
      refreshFailure = value;
    },
    setRevokeFailure() {
      revokeFailure = true;
    },
    setIdentityExpiry(value: "expired" | "missing") {
      identityExpiry = value;
    },
    async expire() {
      await this.store.withLock(async (tx) => {
        const data = await tx.read();
        data.accounts[0].tokens!.expiresAt = Date.now() - 1;
        await tx.save(data);
      });
    },
    cleanup: () => rm(homeDirectory, { recursive: true, force: true }),
  };
}

test("ChatGPT 动态注册验证 PKCE/nonce/签名并保存独立账号，普通取 token 不打开浏览器", async () => {
  const f = await fixture();
  try {
    const account = await f.login();
    assert.equal(account.signedIn, true);
    assert.equal(account.planUsageEnabled, true);
    assert.equal(f.authorization.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(f.authorization.searchParams.get("agent_name_hint"), "HowTo");
    const token = await getChatGptAccessToken({ accountId: account.id }, f.dependencies);
    assert.deepEqual(token, { accessToken: "access-1", accountId: account.id });
    assert.equal(f.tokenCalls, 1);
    const [stored] = await f.store.listAccounts();
    assert.equal(stored.clientId, f.clientId);
    assert.equal(stored.subject, "test-subject");
    assert.equal(
      JSON.stringify(await listChatGptAccounts({}, f.dependencies)).includes("access-1"),
      false,
    );
  } finally {
    await f.cleanup();
  }
});

test("ChatGPT 重登录重用 client/host 且不显示 ID token hint", async () => {
  const f = await fixture();
  try {
    const first = await f.login();
    const hostId = f.authorization.searchParams.get("ext_agent_host_id");
    await f.login(first.id);
    assert.equal(f.authorization.searchParams.get("client_id"), f.clientId);
    assert.equal(f.authorization.searchParams.get("ext_agent_host_id"), hostId);
    assert.equal(f.authorization.searchParams.has("agent_name_hint"), false);
    assert.equal(f.authorization.searchParams.has("id_token_hint"), true);
    assert.equal(f.manualUrls.length, 1);
    assert.equal((await f.store.listAccounts()).length, 1);
  } finally {
    await f.cleanup();
  }
});

test(
  "ChatGPT 无浏览器重登录使用指定端口、剥离提示参数且不启动浏览器",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const reserved = createServer();
    const port = await listen(reserved);
    await new Promise<void>((resolve) => reserved.close(() => resolve()));
    try {
      const first = await f.login();
      const urls: string[] = [];
      let completed: Promise<boolean> | undefined;
      const account = await loginChatGpt(
        {
          accountId: first.id,
          noBrowser: true,
          callbackPort: port,
          onAuthorizationUrl: (url) => {
            urls.push(url);
            completed = f.completeAuthorization(url);
          },
        },
        { ...f.dependencies, openBrowser: () => assert.fail("无浏览器模式调用了启动器") },
      );
      await completed;
      assert.equal(urls.length, 1);
      const authorization = new URL(urls[0]);
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        `http://127.0.0.1:${port}/auth/callback`,
      );
      assert.equal(authorization.searchParams.has("id_token_hint"), false);
      assert.equal(authorization.searchParams.has("login_hint"), false);
      assert.equal(authorization.searchParams.get("client_id"), f.clientId);
      assert.equal(account.id, first.id);
      assert.equal(account.signedIn, true);
      assert.equal(account.planUsageEnabled, true);
      assert.equal((await f.store.listAccounts()).length, 1);
      assert.equal(f.tokenCalls, 2);
    } finally {
      await f.cleanup();
    }
  },
);

test(
  "ChatGPT 指定端口被占用时失败，不启动浏览器、不换端口且保留原凭证",
  { timeout: 15_000 },
  async () => {
    const f = await fixture();
    const occupied = createServer();
    try {
      const account = await f.login();
      const before = await f.store.listAccounts();
      const port = await listen(occupied);
      await assert.rejects(
        loginChatGpt(
          {
            accountId: account.id,
            callbackPort: port,
            onAuthorizationUrl: () => assert.fail("绑定失败后发布了授权链接"),
          },
          { ...f.dependencies, openBrowser: () => assert.fail("绑定失败后打开了浏览器") },
        ),
        (error: unknown) =>
          error instanceof ChatGptError && error.code === "callback_port_unavailable",
      );
      assert.deepEqual(await f.store.listAccounts(), before);
      assert.equal(f.tokenCalls, 1);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
      await f.cleanup();
    }
  },
);

test(
  "ChatGPT 回调端口不能占用凭证互斥端口，授权前拒绝且保留原凭证",
  { timeout: 10_000 },
  async () => {
    const f = await fixture();
    try {
      const account = await f.login();
      const before = await f.store.listAccounts();
      const port = await f.store.withLock((tx) => Promise.resolve(tx.lockPort));
      const requestCount = f.requests.length;
      await assert.rejects(
        loginChatGpt(
          {
            accountId: account.id,
            callbackPort: port,
            onAuthorizationUrl: () => assert.fail("预留端口发布了授权链接"),
          },
          { ...f.dependencies, openBrowser: () => assert.fail("预留端口打开了浏览器") },
        ),
        (error: unknown) =>
          error instanceof ChatGptError && error.code === "callback_port_unavailable",
      );
      assert.equal(f.requests.length, requestCount);
      assert.deepEqual(await f.store.listAccounts(), before);
    } finally {
      await f.cleanup();
    }
  },
);

async function listen(server: Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

for (const mismatch of ["nonce", "subject", "client"] as const) {
  test(`ChatGPT ${mismatch} 不匹配不能覆盖已存凭证`, async () => {
    const f = await fixture();
    try {
      const account = await f.login();
      const before = await f.store.listAccounts();
      if (mismatch === "nonce") f.setNonce("wrong-nonce");
      if (mismatch === "subject") f.setSubject("different-subject");
      if (mismatch === "client") f.setCallbackClient("different-client");
      await assert.rejects(f.login(account.id), ChatGptError);
      assert.deepEqual(await f.store.listAccounts(), before);
    } finally {
      await f.cleanup();
    }
  });
}

for (const expiry of ["expired", "missing"] as const) {
  test(`ChatGPT ID token 的 exp ${expiry} 时不保存凭证`, async () => {
    const f = await fixture();
    try {
      f.setIdentityExpiry(expiry);
      await assert.rejects(f.login(), { code: "invalid_identity" });
      const [registration] = await f.store.listAccounts();
      assert.equal(registration.clientId, f.clientId);
      assert.equal(registration.tokens, undefined);
    } finally {
      await f.cleanup();
    }
  });
}

test("ChatGPT 登录等待期间注销，迟到授权不能复活已注销账号", async () => {
  const f = await fixture();
  try {
    const account = await f.login();
    await assert.rejects(
      loginChatGpt(
        { accountId: account.id },
        {
          ...f.dependencies,
          openBrowser: async (url) => {
            await f.dependencies.openBrowser(url);
            await logoutChatGpt({ accountId: account.id }, f.dependencies);
            return true;
          },
        },
      ),
      { code: "session_changed" },
    );
    assert.equal((await f.store.listAccounts())[0].tokens, undefined);
  } finally {
    await f.cleanup();
  }
});

test("ChatGPT 拒绝授权不交换 code，身份登录不等于额度授权", async () => {
  const f = await fixture();
  try {
    f.setCallbackError();
    await assert.rejects(f.login(), ChatGptError);
    assert.equal(f.tokenCalls, 0);
    assert.deepEqual(await f.store.listAccounts(), []);
  } finally {
    await f.cleanup();
  }
  const g = await fixture();
  try {
    g.setScope("openid profile email offline_access resource.invoke");
    const account = await g.login();
    assert.equal(account.signedIn, true);
    assert.equal(account.planUsageEnabled, false);
    await assert.rejects(getChatGptAccessToken({}, g.dependencies), { code: "plan_permission" });
    await g.login(account.id);
    assert.equal(g.authorization.searchParams.get("prompt"), "consent");
  } finally {
    await g.cleanup();
  }
});

test("ChatGPT 等待浏览器时取消立即释放回调监听", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let callback: string | undefined;
  let browserSignal: AbortSignal | undefined;
  try {
    const pending = loginChatGpt(
      { signal: controller.signal },
      {
        ...f.dependencies,
        openBrowser: (url, signal) => {
          callback = new URL(url).searchParams.get("redirect_uri")!;
          browserSignal = signal;
          controller.abort();
          return new Promise<boolean>(() => undefined);
        },
      },
    );
    await assert.rejects(pending, InteractionCancelledError);
    assert.ok(callback);
    assert.equal(browserSignal?.aborted, true);
    await assert.rejects(fetch(callback));
    assert.equal(f.tokenCalls, 0);
  } finally {
    await f.cleanup();
  }
});

test("ChatGPT 并发刷新只使用一次旋转 token，后来的请求读取新凭证", async () => {
  const f = await fixture();
  try {
    await f.login();
    const before = (await f.store.listAccounts())[0].tokens!;
    await f.expire();
    const observations = [new Set<string>(), new Set<string>()];
    const results = await Promise.all(
      observations.map((observed) =>
        getChatGptAccessToken(
          { onCredentials: (values) => values.forEach((value) => observed.add(value)) },
          f.dependencies,
        ),
      ),
    );
    const after = (await f.store.listAccounts())[0].tokens!;
    assert.equal(f.refreshCalls, 1);
    assert.equal(results[0].accessToken, "access-2");
    assert.deepEqual(results[0], results[1]);
    assert.equal(after.refreshToken, "refresh-2");
    // 锁竞争顺序不由调用顺序保证；实际刷新者必须独立观察到旋转前后的整组凭据。
    assert.deepEqual(
      observations.find((observed) => observed.has(before.accessToken)),
      new Set([
        before.accessToken,
        before.refreshToken,
        before.idToken,
        after.accessToken,
        after.refreshToken,
        after.idToken,
      ]),
    );
  } finally {
    await f.cleanup();
  }
});

test("ChatGPT 刷新标记写盘时取消不发送 token，之后仍可使用原凭据刷新", async (t) => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    const before = await f.store.listAccounts();
    const controller = new AbortController();
    const accountsPath = await fs.realpath(
      join(f.dependencies.homeDirectory, ".howto", "chatgpt", "accounts.json"),
    );
    const rename = fs.rename;
    let cancelled = false;
    // 在原子替换完成、save 尚未返回时安排取消，避免依赖文件监听或计时器抢占窄窗口。
    const replacement = t.mock.method(fs, "rename", async (...paths: Parameters<typeof rename>) => {
      await rename(...paths);
      if (paths[1] === accountsPath && !cancelled) {
        cancelled = true;
        controller.abort();
      }
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(
        getChatGptAccessToken({ signal: controller.signal }, f.dependencies),
        InteractionCancelledError,
      );
    } finally {
      replacement.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(cancelled, true);
    assert.equal(f.refreshCalls, 0);
    assert.deepEqual(await f.store.listAccounts(), before);
    assert.equal((await getChatGptAccessToken({}, f.dependencies)).accessToken, "access-2");
    assert.equal(f.refreshCalls, 1);
  } finally {
    await f.cleanup();
  }
});

test("ChatGPT 刷新请求已发送后取消仍禁止重放原 token", async () => {
  const f = await fixture();
  try {
    await f.login();
    await f.expire();
    const controller = new AbortController();
    let refreshCalls = 0;
    const dependencies = {
      ...f.dependencies,
      fetch: (async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url === metadata.token_endpoint) {
          refreshCalls++;
          controller.abort();
          throw new Error("secret upstream detail");
        }
        return f.dependencies.fetch(input, init);
      }) satisfies typeof fetch,
    };
    await assert.rejects(
      getChatGptAccessToken({ signal: controller.signal }, dependencies),
      InteractionCancelledError,
    );
    assert.equal((await f.store.listAccounts())[0].refreshState, "reauth_required");
    await assert.rejects(getChatGptAccessToken({}, dependencies), { code: "refresh_invalid" });
    assert.equal(refreshCalls, 1);
  } finally {
    await f.cleanup();
  }
});

for (const failure of ["invalid_grant", "temporarily_unavailable", "network"]) {
  test(`ChatGPT refresh ${failure} 的恢复不会重放失效 token 或泄露异常`, async () => {
    const f = await fixture();
    try {
      await f.login();
      await f.expire();
      f.setRefreshFailure(failure);
      await assert.rejects(
        getChatGptAccessToken({}, f.dependencies),
        (error: unknown) => error instanceof ChatGptError && !error.message.includes("secret"),
      );
      const [account] = await f.store.listAccounts();
      assert.equal(account.clientId, f.clientId);
      if (failure === "invalid_grant") assert.equal(account.tokens, undefined);
      else assert.equal(account.tokens?.refreshToken, "refresh-1");
      if (failure === "network") {
        assert.equal(account.refreshState, "reauth_required");
        await assert.rejects(getChatGptAccessToken({}, f.dependencies), {
          code: "refresh_invalid",
        });
        assert.equal(f.refreshCalls, 1);
      }
      if (failure === "temporarily_unavailable") {
        f.setRefreshFailure(undefined);
        assert.equal((await getChatGptAccessToken({}, f.dependencies)).accessToken, "access-3");
      }
    } finally {
      await f.cleanup();
    }
  });
}

for (const remoteFailure of [false, true]) {
  test(`ChatGPT 注销清除选中账号凭证并保留 client，远程撤销失败=${remoteFailure}`, async () => {
    const f = await fixture();
    try {
      const account = await f.login();
      if (remoteFailure) f.setRevokeFailure();
      const result = await logoutChatGpt({ accountId: account.id }, f.dependencies);
      assert.equal(result.remoteRevocationConfirmed, !remoteFailure);
      const [stored] = await f.store.listAccounts();
      assert.equal(stored.tokens, undefined);
      assert.equal(stored.clientId, f.clientId);
      assert.equal(stored.subject, "test-subject");
      await assert.rejects(getChatGptAccessToken({}, f.dependencies), { code: "login_required" });
    } finally {
      await f.cleanup();
    }
  });
}
