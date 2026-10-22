import { randomUUID } from "node:crypto";
import { ChatGptError, TERMINAL_REFRESH_ERRORS } from "./errors.js";
import {
  CHATGPT_ISSUER,
  CHATGPT_RESOURCE,
  checkCancellation,
  discoverOpenIdConfiguration,
  OAuthHttpError,
  requestJson,
  type Fetch,
} from "./http.js";
import {
  authorizeChatGpt,
  parseTokenResponse,
  validateIdentity,
  type OAuthDependencies,
} from "./oauth.js";
import { createChatGptStore } from "./storage.js";
import type { AccountRecord } from "./types.js";

export interface ChatGptAccountInfo {
  id: string;
  label: string;
  email?: string;
  signedIn: boolean;
  planUsageEnabled: boolean;
}

interface AccountOptions {
  accountId?: string;
  signal?: AbortSignal;
}
interface Dependencies extends OAuthDependencies {
  homeDirectory?: string;
}

function accountInfo(account: AccountRecord): ChatGptAccountInfo {
  return {
    id: account.id,
    label: account.label,
    email: account.email,
    signedIn: account.tokens !== undefined && account.refreshState === undefined,
    planUsageEnabled: account.tokens?.scopes.includes("chatgpt.tokens.use.direct") ?? false,
  };
}

function selectAccount(accounts: AccountRecord[], accountId?: string): AccountRecord {
  if (accountId !== undefined) {
    const account = accounts.find((item) => item.id === accountId);
    if (account === undefined) throw new ChatGptError("account_not_found");
    return account;
  }
  if (accounts.length === 0) throw new ChatGptError("login_required");
  if (accounts.length !== 1) throw new ChatGptError("account_required");
  return accounts[0];
}

export async function listChatGptAccounts(
  options: { signal?: AbortSignal } = {},
  dependencies: Dependencies = {},
): Promise<ChatGptAccountInfo[]> {
  return (await createChatGptStore(dependencies.homeDirectory).listAccounts(options.signal)).map(
    accountInfo,
  );
}

export async function loginChatGpt(
  options: AccountOptions & { onAuthorizationUrl?: (url: string) => void } = {},
  dependencies: Dependencies = {},
): Promise<ChatGptAccountInfo> {
  const store = createChatGptStore(dependencies.homeDirectory);
  const pending = await store.withLock(async (transaction) => {
    const data = await transaction.read();
    const account =
      options.accountId === undefined ? undefined : selectAccount(data.accounts, options.accountId);
    return {
      hostId: await transaction.getHostId(),
      account,
      generation: account?.generation ?? 0,
      id: account?.id ?? randomUUID(),
    };
  }, options.signal);
  let registeredClientId = pending.account?.clientId;
  const result = await authorizeChatGpt(
    {
      hostId: pending.hostId,
      clientId: pending.account?.clientId,
      subject: pending.account?.subject,
      idTokenHint: pending.account?.tokens?.idToken,
      email: pending.account?.email,
      requestPlanConsent:
        pending.account?.tokens !== undefined &&
        !pending.account.tokens.scopes.includes("chatgpt.tokens.use.direct"),
      signal: options.signal,
      onAuthorizationUrl: options.onAuthorizationUrl,
      onRegistration: async (clientId) => {
        registeredClientId = clientId;
        await store.withLock(async (transaction) => {
          const data = await transaction.read();
          const current = data.accounts.find((item) => item.id === pending.id);
          if (
            current !== undefined &&
            (current.generation !== pending.generation || current.clientId !== clientId)
          )
            throw new ChatGptError("session_changed");
          if (current === undefined) {
            data.accounts.push({
              id: pending.id,
              label: `ChatGPT ${pending.id.slice(0, 8)}`,
              clientId,
              issuer: CHATGPT_ISSUER,
              generation: pending.generation,
            });
            await transaction.save(data);
          }
        }, options.signal);
      },
    },
    dependencies,
  );
  return store.withLock(async (transaction) => {
    checkCancellation(options.signal);
    const data = await transaction.read();
    const account = data.accounts.find((item) => item.id === pending.id);
    if (
      account === undefined ||
      account.generation !== pending.generation ||
      account.clientId !== registeredClientId
    )
      throw new ChatGptError("session_changed");
    account.subject = result.subject;
    account.email = result.email;
    account.label = `${result.email ?? "ChatGPT"} (${account.id.slice(0, 8)})`;
    account.tokens = result.tokens;
    account.refreshState = undefined;
    account.generation += 1;
    await transaction.save(data);
    return accountInfo(account);
  }, options.signal);
}

export async function getChatGptAccessToken(
  options: AccountOptions = {},
  dependencies: Dependencies = {},
): Promise<{ accessToken: string; accountId: string }> {
  const store = createChatGptStore(dependencies.homeDirectory);
  return store.withLock(async (transaction) => {
    checkCancellation(options.signal);
    const data = await transaction.read();
    const account = selectAccount(data.accounts, options.accountId);
    const previous = account.tokens;
    if (previous === undefined) throw new ChatGptError("login_required");
    if (account.refreshState !== undefined) throw new ChatGptError("refresh_invalid");
    if (!previous.scopes.includes("chatgpt.tokens.use.direct"))
      throw new ChatGptError("plan_permission");
    const now = Date.now();
    if (
      previous.expiresAt > now + 60_000 ||
      (previous.expiresAt > now && (previous.earliestRefreshAt ?? 0) > now)
    ) {
      return { accessToken: previous.accessToken, accountId: account.id };
    }
    if (!previous.refreshToken) throw new ChatGptError("refresh_invalid");
    const metadata = await discoverOpenIdConfiguration(options.signal, dependencies.fetch);
    account.refreshState = "refreshing";
    await transaction.save(data);
    try {
      const response = await requestJson(
        metadata.token_endpoint,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: account.clientId,
            refresh_token: previous.refreshToken,
            resource: CHATGPT_RESOURCE,
          }),
        },
        options.signal,
        dependencies.fetch,
      );
      const tokens = parseTokenResponse(response, previous);
      if (tokens.idToken !== previous.idToken) {
        await validateIdentity(tokens.idToken, account.clientId, metadata, {
          subject: account.subject,
          signal: options.signal,
          fetcher: dependencies.fetch,
        });
      }
      account.tokens = tokens;
      account.refreshState = undefined;
      account.generation += 1;
      await transaction.save(data);
      if (!tokens.scopes.includes("chatgpt.tokens.use.direct"))
        throw new ChatGptError("plan_permission");
      return { accessToken: tokens.accessToken, accountId: account.id };
    } catch (error) {
      if (account.refreshState === undefined) throw error;
      if (error instanceof OAuthHttpError && TERMINAL_REFRESH_ERRORS.has(error.oauthCode ?? "")) {
        account.tokens = undefined;
        account.refreshState = undefined;
        account.generation += 1;
        await transaction.save(data);
        throw new ChatGptError("refresh_invalid");
      }
      // 明确的服务端失败保留当前凭证；中断或丢失响应无法安全重放旋转 token。
      account.refreshState = error instanceof OAuthHttpError ? undefined : "reauth_required";
      await transaction.save(data);
      throw error;
    }
  }, options.signal);
}

export async function logoutChatGpt(
  options: AccountOptions = {},
  dependencies: Dependencies = {},
): Promise<{ account: ChatGptAccountInfo; remoteRevocationConfirmed: boolean }> {
  const store = createChatGptStore(dependencies.homeDirectory);
  return store.withLock(async (transaction) => {
    const data = await transaction.read();
    const account = selectAccount(data.accounts, options.accountId);
    let remoteRevocationConfirmed = account.tokens === undefined;
    try {
      if (account.tokens?.refreshToken) {
        const metadata = await discoverOpenIdConfiguration(options.signal, dependencies.fetch);
        remoteRevocationConfirmed = await revokeSession(
          metadata.revocation_endpoint,
          account,
          options.signal,
          dependencies.fetch,
        );
      }
    } catch {
      /* 即使远程撤销未确认，也清除本地凭证并明确报告。 */
    }
    account.tokens = undefined;
    account.refreshState = undefined;
    account.generation += 1;
    await transaction.save(data);
    return { account: accountInfo(account), remoteRevocationConfirmed };
  }, options.signal);
}

async function revokeSession(
  url: string,
  account: AccountRecord,
  signal?: AbortSignal,
  fetcher: Fetch = globalThis.fetch,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    checkCancellation(signal);
    try {
      const timeout = AbortSignal.timeout(15_000);
      const response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        redirect: "error",
        body: new URLSearchParams({
          token: account.tokens?.refreshToken ?? "",
          token_type_hint: "refresh_token",
          client_id: account.clientId,
        }),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      await response.body?.cancel();
      if (response.status === 200) return true;
      if (response.status < 500) return false;
    } catch {
      checkCancellation(signal);
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}
