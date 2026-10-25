import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { InteractionCancelledError } from "../../ui/tty.js";
import { ChatGptError } from "./errors.js";
import {
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  checkCancellation,
  discoverOpenIdConfiguration,
  isRecord,
  requestJson,
  type Fetch,
  type OpenIdConfiguration,
} from "./http.js";
import type { AccountRecord, ChatGptLoginOptions } from "./types.js";

export const CHATGPT_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
type Tokens = NonNullable<AccountRecord["tokens"]>;

export interface OAuthDependencies {
  fetch?: Fetch;
  openBrowser?: (url: string, signal?: AbortSignal) => Promise<boolean>;
}

export interface AuthorizationOptions extends ChatGptLoginOptions {
  hostId: string;
  clientId?: string;
  subject?: string;
  idTokenHint?: string;
  email?: string;
  requestPlanConsent?: boolean;
  signal?: AbortSignal;
  onAuthorizationUrl?: (url: string) => void;
  onRegistration: (clientId: string) => Promise<void>;
}

export async function openSystemBrowser(url: string, signal?: AbortSignal): Promise<boolean> {
  checkCancellation(signal);
  return new Promise((resolve) => {
    const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], {
      stdio: "ignore",
      shell: false,
    });
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      resolve(opened);
    };
    const stop = () => {
      if (settled) return;
      if (child.pid !== undefined) {
        // 只终止本次启动器；不向进程组发信号，以免关闭用户已打开的浏览器。
        killTimer = setTimeout(() => child.kill("SIGKILL"), 500);
        child.kill("SIGTERM");
      }
      finish(false);
    };
    const timer = setTimeout(stop, 10_000);
    child.once("error", () => {
      clearTimeout(killTimer);
      finish(false);
    });
    child.once("exit", (code) => {
      clearTimeout(killTimer);
      finish(code === 0);
    });
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
  });
}

export async function authorizeChatGpt(
  options: AuthorizationOptions,
  dependencies: OAuthDependencies = {},
) {
  if (
    options.callbackPort !== undefined &&
    (!Number.isSafeInteger(options.callbackPort) ||
      options.callbackPort < 1 ||
      options.callbackPort > 65535)
  )
    throw new ChatGptError("invalid_callback_port");
  const timeout = AbortSignal.timeout(600_000);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const metadata = await discoverOpenIdConfiguration(signal, dependencies.fetch);
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const listener = await listenForAuthorization(
    state,
    options.clientId,
    signal,
    options.callbackPort,
  );
  try {
    const authorization = new URL(metadata.authorization_endpoint);
    authorization.search = new URLSearchParams({
      client_id: options.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: options.hostId,
      response_type: "code",
      redirect_uri: listener.redirectUri,
      scope: CHATGPT_SCOPES,
      resource: CHATGPT_RESOURCE,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    if (options.clientId === undefined) authorization.searchParams.set("agent_name_hint", "HowTo");
    else {
      if (options.idTokenHint !== undefined)
        authorization.searchParams.set("id_token_hint", options.idTokenHint);
      if (options.email !== undefined) authorization.searchParams.set("login_hint", options.email);
      // 用户显式再次登录时可以补授此前未开放的 plan usage 权限。
      if (options.requestPlanConsent) authorization.searchParams.set("prompt", "consent");
    }
    checkCancellation(signal);
    const opened = options.noBrowser
      ? false
      : await awaitWithCancellation(
          (dependencies.openBrowser ?? openSystemBrowser)(authorization.toString(), signal),
          signal,
        );
    checkCancellation(signal);
    if (!opened || options.idTokenHint === undefined) {
      // 手动打开地址不得包含保留的 ID token，避免终端历史泄露。
      authorization.searchParams.delete("id_token_hint");
      authorization.searchParams.delete("login_hint");
      options.onAuthorizationUrl?.(authorization.toString());
    }
    const result = await listener.result;
    checkCancellation(signal);
    await options.onRegistration(result.clientId);
    const value = await requestJson(
      metadata.token_endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: result.clientId,
          code: result.code,
          code_verifier: verifier,
          redirect_uri: listener.redirectUri,
          resource: CHATGPT_RESOURCE,
        }),
      },
      signal,
      dependencies.fetch,
    );
    const tokens = parseTokenResponse(value);
    const identity = await validateIdentity(tokens.idToken, result.clientId, metadata, {
      nonce,
      subject: options.subject,
      signal,
      fetcher: dependencies.fetch,
    });
    return { clientId: result.clientId, tokens, ...identity };
  } catch (error) {
    if (options.signal?.aborted) throw new InteractionCancelledError();
    if (timeout.aborted) throw new ChatGptError("authorization_timeout");
    if (error instanceof ChatGptError || error instanceof InteractionCancelledError) throw error;
    throw new ChatGptError("authorization_failed");
  } finally {
    listener.close();
  }
}

async function awaitWithCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  checkCancellation(signal);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new InteractionCancelledError());
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function parseTokenResponse(value: unknown, previous?: Tokens): Tokens {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    typeof value.refresh_token !== "string" ||
    value.refresh_token.length === 0 ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    typeof value.expires_in !== "number" ||
    !Number.isSafeInteger(value.expires_in) ||
    value.expires_in <= 0 ||
    value.expires_in > 86_400 ||
    (value.scope !== undefined && typeof value.scope !== "string")
  )
    throw new ChatGptError("invalid_response");
  const idToken = typeof value.id_token === "string" ? value.id_token : previous?.idToken;
  const scopes =
    typeof value.scope === "string" ? value.scope.split(/\s+/).filter(Boolean) : previous?.scopes;
  if (!idToken || scopes === undefined) throw new ChatGptError("invalid_response");
  const savedAt = Date.now();
  return {
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    idToken,
    scopes,
    expiresAt: savedAt + value.expires_in * 1000,
    savedAt,
    earliestRefreshAt:
      typeof value.earliest_refresh_at === "number" &&
      Number.isSafeInteger(value.earliest_refresh_at)
        ? value.earliest_refresh_at * 1000
        : undefined,
  };
}

export async function validateIdentity(
  idToken: string,
  clientId: string,
  metadata: OpenIdConfiguration,
  options: { nonce?: string; subject?: string; signal?: AbortSignal; fetcher?: Fetch } = {},
) {
  try {
    const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), {
      timeoutDuration: 15_000,
      [customFetch]: (url, init) =>
        (options.fetcher ?? globalThis.fetch)(url, {
          ...init,
          redirect: "error",
          signal:
            options.signal === undefined
              ? init.signal
              : AbortSignal.any([options.signal, ...(init.signal ? [init.signal] : [])]),
        }),
    });
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: CHATGPT_ISSUER,
      audience: clientId,
      requiredClaims: ["exp", "iat", "sub", ...(options.nonce === undefined ? [] : ["nonce"])],
      algorithms: ["RS256", "ES256"],
    });
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      (options.nonce !== undefined && payload.nonce !== options.nonce) ||
      (options.subject !== undefined && payload.sub !== options.subject)
    )
      throw new ChatGptError("invalid_identity");
    checkCancellation(options.signal);
    return {
      subject: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    checkCancellation(options.signal);
    throw new ChatGptError("invalid_identity");
  }
}

async function listenForAuthorization(
  state: string,
  clientId: string | undefined,
  signal: AbortSignal,
  port = 0,
) {
  let resolve!: (value: { code: string; clientId: string }) => void;
  let reject!: (error: Error) => void;
  let settled = false;
  const result = new Promise<{ code: string; clientId: string }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void result.catch(() => undefined);
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400).end("Invalid callback path");
      return;
    }
    if (request.method !== "GET" || url.pathname !== "/auth/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    if (
      settled ||
      url.searchParams.getAll("state").length !== 1 ||
      url.searchParams.get("state") !== state
    ) {
      response.writeHead(400).end("Invalid state");
      return;
    }
    settled = true;
    if (url.searchParams.has("error")) {
      response.writeHead(400).end("Authorization was not completed. Return to HowTo.");
      reject(new ChatGptError("authorization_failed"));
      return;
    }
    const code = url.searchParams.get("code");
    const issuedClientId = url.searchParams.get("client_id") ?? clientId;
    if (
      !code ||
      !issuedClientId ||
      issuedClientId === "dynamic_agent_client" ||
      url.searchParams.getAll("code").length !== 1 ||
      url.searchParams.getAll("client_id").length > 1 ||
      (clientId !== undefined && issuedClientId !== clientId)
    ) {
      response.writeHead(400).end("Invalid callback");
      reject(new ChatGptError("authorization_failed"));
      return;
    }
    response.end(
      "HowTo authorization received. You can close this window and return to the terminal.",
    );
    resolve({ code, clientId: issuedClientId });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((yes, no) => {
      server.once("error", no);
      server.listen(port, "127.0.0.1", yes);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new ChatGptError("authorization_failed");
    const abort = () => {
      settled = true;
      reject(new InteractionCancelledError());
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    return {
      redirectUri: `http://127.0.0.1:${address.port}/auth/callback`,
      result,
      close() {
        signal.removeEventListener("abort", abort);
        server.closeAllConnections();
        server.close();
      },
    };
  } catch {
    server.closeAllConnections();
    server.close();
    checkCancellation(signal);
    throw new ChatGptError("callback_port_unavailable");
  }
}
