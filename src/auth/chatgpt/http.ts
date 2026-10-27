import { InteractionCancelledError } from "../../ui/tty.js";
import { ChatGptError, classifyChatGptHttpError } from "./errors.js";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export type Fetch = typeof globalThis.fetch;

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw new InteractionCancelledError();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new ChatGptError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_048_576) throw new ChatGptError("invalid_response");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ChatGptError) throw error;
    throw new ChatGptError("invalid_response");
  } finally {
    reader.releaseLock();
  }
}

export class OAuthHttpError extends ChatGptError {
  constructor(
    readonly status: number,
    readonly oauthCode?: string,
  ) {
    super(classifyChatGptHttpError(status, oauthCode).code);
  }
}

export async function requestJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  fetcher: Fetch = globalThis.fetch,
): Promise<unknown> {
  checkCancellation(signal);
  const timeout = AbortSignal.timeout(30_000);
  try {
    const response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      let code: string | undefined;
      try {
        const body = await readBoundedJson(response);
        if (isRecord(body)) {
          const value =
            typeof body.error === "string"
              ? body.error
              : isRecord(body.error)
                ? body.error.code
                : undefined;
          if (typeof value === "string" && /^[a-z_]{1,80}$/.test(value)) code = value;
        }
      } catch {
        /* 上游正文只用于机器分类，绝不回显。 */
      }
      throw new OAuthHttpError(response.status, code);
    }
    return await readBoundedJson(response);
  } catch (error) {
    checkCancellation(signal);
    if (error instanceof ChatGptError) throw error;
    throw new ChatGptError("network");
  }
}

export interface OpenIdConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
}

export async function discoverOpenIdConfiguration(
  signal?: AbortSignal,
  fetcher?: Fetch,
): Promise<OpenIdConfiguration> {
  const metadata = await requestJson(
    `${CHATGPT_ISSUER}/.well-known/openid-configuration`,
    {},
    signal,
    fetcher,
  );
  if (
    !isRecord(metadata) ||
    metadata.issuer !== CHATGPT_ISSUER ||
    metadata.authorization_endpoint !== `${CHATGPT_ISSUER}/api/accounts/authorize` ||
    metadata.token_endpoint !== `${CHATGPT_ISSUER}/api/accounts/oauth/token` ||
    metadata.revocation_endpoint !== `${CHATGPT_ISSUER}/api/accounts/oauth/revoke` ||
    metadata.jwks_uri !== `${CHATGPT_ISSUER}/.well-known/jwks.json`
  ) {
    throw new ChatGptError("invalid_response");
  }
  return metadata as unknown as OpenIdConfiguration;
}
