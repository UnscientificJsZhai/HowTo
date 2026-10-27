import { getChatGptAccessToken, type ChatGptAccessTokenOptions } from "../auth/chatgpt/index.js";
import { ChatGptError, classifyChatGptHttpError } from "../auth/chatgpt/errors.js";
import { ConfigError } from "../config.js";
import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";
import { InteractionCancelledError } from "../ui/tty.js";
import { AiProviderError, UsageToolsUnsupportedError } from "./errors.js";

export interface ChatGptModel {
  slug: string;
  displayName: string;
}

export interface ChatGptRequestOptions {
  accountId?: string;
  signal?: AbortSignal;
}

export interface ChatGptDependencies {
  getAccessToken?: (
    options: ChatGptAccessTokenOptions,
  ) => Promise<{ accessToken: string; accountId: string }>;
  fetch?: typeof globalThis.fetch;
  timeoutMilliseconds?: number;
}

const MODEL_CATALOG_URL = "https://api.openai.com/v1/models";
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 120_000;

export async function listChatGptModels(
  options: ChatGptRequestOptions = {},
  dependencies: ChatGptDependencies = {},
): Promise<ChatGptModel[]> {
  return runChatGptRequest("models", options.signal, dependencies, async (signal) => {
    const credentials = await (dependencies.getAccessToken ?? getChatGptAccessToken)({
      accountId: options.accountId,
      signal,
    });
    return requestChatGptModels(
      credentials.accessToken,
      signal,
      dependencies.fetch ?? globalThis.fetch,
    );
  });
}

export async function requestChatGptModels(
  accessToken: string,
  signal: AbortSignal,
  fetch: typeof globalThis.fetch,
): Promise<ChatGptModel[]> {
  signal.throwIfAborted();
  const response = await fetch(MODEL_CATALOG_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    throw await chatGptHttpError(response, signal);
  }
  return parseChatGptModels(await readChatGptJson(response, signal, MAX_CATALOG_BYTES));
}

export function parseChatGptModels(value: unknown): ChatGptModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new AiProviderError("chatgpt", "models");
  }
  const models: ChatGptModel[] = [];
  const slugs = new Set<string>();
  for (const entry of value.models) {
    if (!isRecord(entry)) throw new AiProviderError("chatgpt", "models");
    if (entry.visibility !== "list") continue;
    if (!isModelLabel(entry.slug) || !isModelLabel(entry.display_name) || slugs.has(entry.slug)) {
      throw new AiProviderError("chatgpt", "models");
    }
    models.push({ slug: entry.slug, displayName: entry.display_name });
    slugs.add(entry.slug);
  }
  return models;
}

function isModelLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value === value.trim() &&
    value.length <= 256 &&
    !/[\r\n]/.test(value) &&
    !hasUnsafeTerminalControlCharacters(value)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 统一限制整个操作（凭证、模型目录和推理）的时长，并在出口隔离原始异常。
export async function runChatGptRequest<T>(
  model: string,
  signal: AbortSignal | undefined,
  dependencies: ChatGptDependencies,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new InteractionCancelledError();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  let rejectAborted!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = () => reject(new AiProviderError("chatgpt", model));
  });
  controller.signal.addEventListener("abort", rejectAborted, { once: true });
  const timeout = setTimeout(
    cancel,
    dependencies.timeoutMilliseconds ?? REQUEST_TIMEOUT_MILLISECONDS,
  );
  try {
    const result = await Promise.race([operation(controller.signal), aborted]);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted || error instanceof InteractionCancelledError) {
      throw new InteractionCancelledError();
    }
    if (
      error instanceof ChatGptError ||
      error instanceof ConfigError ||
      error instanceof UsageToolsUnsupportedError
    )
      throw error;
    throw new AiProviderError("chatgpt", model);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectAborted);
    controller.abort();
  }
}

export async function chatGptHttpError(
  response: Response,
  signal: AbortSignal,
): Promise<ChatGptError> {
  let code: string | undefined;
  try {
    const body = await readChatGptJson(response, signal, MAX_ERROR_BYTES);
    if (isRecord(body) && isRecord(body.error) && typeof body.error.code === "string") {
      code = body.error.code;
    }
  } catch {
    // 非 JSON、过大或 detail 字符串错误只按状态分类，不展示上游正文。
  }
  return classifyChatGptHttpError(response.status, code);
}

async function readChatGptJson(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<unknown> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  for await (const bytes of readChatGptBody(response, signal, maximumBytes)) {
    text += decoder.decode(bytes, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}

// 字节上限位于 JSON/SSE 解码之前，避免单个未结束事件无限占用内存。
export async function* readChatGptBody(
  response: Response,
  signal: AbortSignal,
  maximumBytes: number,
): AsyncGenerator<Uint8Array> {
  if (response.body === null) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  let received = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return;
      received += chunk.value.byteLength;
      if (received > maximumBytes) throw new Error("Response body too large");
      yield chunk.value;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
