import type {
  ResponseCreateParamsStreaming,
  ResponseInputItem,
} from "openai/resources/responses/responses";

import { getChatGptAccessToken } from "../auth/chatgpt/index.js";
import { classifyChatGptHttpError } from "../auth/chatgpt/errors.js";
import { type AppConfig, ConfigError } from "../config.js";
import type { UsageGenerationSession, UsageLookupResult, UsageToolCall } from "../usage/types.js";
import { sanitizeUsageLookupResult } from "../usage/output.js";
import { COMMAND_GENERATION_SCHEMA, USAGE_COMMAND_GENERATION_SCHEMA } from "./command-schema.js";
import {
  type ChatGptDependencies,
  chatGptHttpError,
  isRecord,
  readChatGptBody,
  requestChatGptModels,
  runChatGptRequest,
} from "./chatgpt-models.js";
import { AiProviderError, UsageToolsUnsupportedError } from "./errors.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";
import {
  isExplicitUsageToolsUnsupported,
  parseUsageToolArguments,
  USAGE_TOOL_DESCRIPTION,
  USAGE_TOOL_NAME,
  USAGE_TOOL_PARAMETERS,
  UsageReplyTracker,
} from "./usage-session.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

export class ChatGptCommandProvider implements CommandProvider {
  private readonly model: string;

  constructor(
    private readonly config: AppConfig["chatgpt"],
    private readonly dependencies: ChatGptDependencies = {},
  ) {
    if (config.model === undefined || config.model.trim() === "") {
      throw new ConfigError(
        "ChatGPT model is not configured. Run howto --chatgpt-models to list available models, or howto --init to select one.",
      );
    }
    this.model = config.model;
  }

  createUsageSession(request: GenerateCommandsRequest): UsageGenerationSession {
    const initial = buildChatGptResponseRequest(this.model, request);
    const input = initial.input as ResponseInputItem[];
    const tracker = new UsageReplyTracker("chatgpt", this.model);
    const knownCredentials = new Set<string>();
    const toolResults = new Map<string, UsageLookupResult>();
    let credentialsChanged = false;
    let modelVerified = false;
    return {
      getKnownCredentials: () => [...knownCredentials],
      next: (replies, options, signal) =>
        runChatGptRequest(this.model, signal, this.dependencies, async (requestSignal) => {
          const previousCredentialCount = knownCredentials.size;
          const observeCredentials = (values: readonly string[]) => {
            if (requestSignal.aborted) return;
            for (const value of values) knownCredentials.add(value);
            // 观察时即记录旋转，后续取消不能让重试丢失截断输出保护。
            credentialsChanged ||=
              previousCredentialCount > 0 && knownCredentials.size > previousCredentialCount;
          };
          const credentials = await (this.dependencies.getAccessToken ?? getChatGptAccessToken)({
            accountId: this.config.account,
            signal: requestSignal,
            onCredentials: observeCredentials,
          });
          requestSignal.throwIfAborted();
          observeCredentials([credentials.accessToken]);
          // 审批期间凭据可能已刷新；在序列化工具结果前再次按最新的整组令牌脱敏。
          for (const reply of tracker.accept(replies)) {
            toolResults.set(reply.callId, reply.result);
            input.push({
              type: "function_call_output",
              call_id: reply.callId,
              output: "",
            });
          }
          // 重试和后续轮次也重新处理历史结果，避免沿用旧凭据集合下的序列化内容。
          for (const item of input) {
            if (item.type !== "function_call_output") continue;
            const result = toolResults.get(item.call_id);
            if (result === undefined) continue;
            const sanitized = sanitizeUsageLookupResult(result, [...knownCredentials]);
            if (credentialsChanged) {
              // 新令牌可能已被截断为无法精确匹配的片段；缓存重放同样适用。
              for (const channel of ["stdout", "stderr"] as const) {
                if (sanitized[`${channel}Truncated`]) {
                  sanitized[channel] =
                    "[redacted: truncated output omitted after credential rotation]";
                  sanitized.credentialsRedacted = true;
                }
              }
            }
            toolResults.set(item.call_id, sanitized);
            item.output = JSON.stringify(sanitized);
          }
          const fetch = this.dependencies.fetch ?? globalThis.fetch;
          if (!modelVerified) {
            const models = await requestChatGptModels(
              credentials.accessToken,
              requestSignal,
              fetch,
            );
            if (!models.some((model) => model.slug === this.model)) {
              throw new ConfigError(
                "The selected ChatGPT model is unavailable for this account. Run howto --chatgpt-models or howto --init to select an available model.",
              );
            }
            modelVerified = true;
          }
          requestSignal.throwIfAborted();
          const parameters: ResponseCreateParamsStreaming = {
            ...initial,
            input: [...input],
            include: ["reasoning.encrypted_content"],
            text: {
              format: request.structuredOutput
                ? {
                    type: "json_schema",
                    name: "command_usage_generation",
                    schema: USAGE_COMMAND_GENERATION_SCHEMA,
                    strict: true,
                  }
                : { type: "json_object" },
            },
            ...(options.toolsEnabled
              ? {
                  tools: [
                    {
                      type: "function",
                      name: USAGE_TOOL_NAME,
                      description: USAGE_TOOL_DESCRIPTION,
                      parameters: USAGE_TOOL_PARAMETERS,
                      strict: true,
                    },
                  ],
                  tool_choice: "auto",
                  parallel_tool_calls: false,
                }
              : {}),
          };
          const response = await fetch(RESPONSES_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
              Accept: "text/event-stream",
              "Content-Type": "application/json",
            },
            body: JSON.stringify(parameters),
            redirect: "error",
            signal: requestSignal,
          });
          if (!response.ok) {
            throw await usageChatGptHttpError(
              response,
              requestSignal,
              this.model,
              options.toolsEnabled,
            );
          }
          const contentType = response.headers.get("content-type");
          if (
            contentType !== null &&
            contentType.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
          ) {
            void response.body?.cancel().catch(() => undefined);
            throw new AiProviderError("chatgpt", this.model);
          }
          const output = await collectChatGptUsageOutput(
            response,
            requestSignal,
            this.model,
            options.toolsEnabled,
          );
          requestSignal.throwIfAborted();
          const calls: UsageToolCall[] = [];
          for (const item of output) {
            if (item.type === "function_call") {
              calls.push({
                id: item.call_id as string,
                name: item.name as string,
                arguments: parseUsageToolArguments(item.arguments as string),
              });
            }
          }
          if (calls.length > 0) {
            tracker.register(calls);
            // store:false 会话必须回传完整 reasoning（含加密内容）、消息和调用项。
            input.push(...(output as unknown as ResponseInputItem[]));
            return { kind: "tool_calls", calls };
          }
          const rawText = output.map((item) => readCompletedItemText(item, this.model)).join("");
          if (rawText.trim() === "" || Buffer.byteLength(rawText, "utf8") > MAX_OUTPUT_BYTES) {
            throw new AiProviderError("chatgpt", this.model);
          }
          return { kind: "final", rawText };
        }),
    };
  }

  async generateCommands(
    request: GenerateCommandsRequest,
    signal?: AbortSignal,
  ): Promise<GenerateCommandsResult> {
    return runChatGptRequest(this.model, signal, this.dependencies, async (requestSignal) => {
      const credentials = await (this.dependencies.getAccessToken ?? getChatGptAccessToken)({
        accountId: this.config.account,
        signal: requestSignal,
      });
      const fetch = this.dependencies.fetch ?? globalThis.fetch;
      const models = await requestChatGptModels(credentials.accessToken, requestSignal, fetch);
      if (!models.some((model) => model.slug === this.model)) {
        throw new ConfigError(
          "The selected ChatGPT model is unavailable for this account. Run howto --chatgpt-models or howto --init to select an available model.",
        );
      }
      requestSignal.throwIfAborted();
      // 使用显式 fetch，不读取 SDK 隐式环境头，也不经过可能记录原始 SSE 的 SDK 解码器。
      const response = await fetch(RESPONSES_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(buildChatGptResponseRequest(this.model, request)),
        redirect: "error",
        signal: requestSignal,
      });
      if (!response.ok) throw await chatGptHttpError(response, requestSignal);
      const contentType = response.headers.get("content-type");
      if (
        contentType !== null &&
        contentType.split(";", 1)[0].trim().toLowerCase() !== "text/event-stream"
      ) {
        void response.body?.cancel().catch(() => undefined);
        throw new AiProviderError("chatgpt", this.model);
      }
      return { rawText: await collectChatGptResponse(response, requestSignal, this.model) };
    });
  }
}

export function buildChatGptResponseRequest(
  model: string,
  request: GenerateCommandsRequest,
): ResponseCreateParamsStreaming {
  return {
    model,
    instructions: request.systemPrompt,
    input: [
      {
        role: "user",
        // JSON mode 的输入校验可能不计入 instructions，需要在用户输入中明确格式。
        content: request.structuredOutput
          ? request.userPrompt
          : `Return JSON matching the instructions.\n${request.userPrompt}`,
      },
    ],
    store: false,
    stream: true,
    text: {
      format: request.structuredOutput
        ? {
            type: "json_schema",
            name: "command_generation",
            description: "Shell command candidates generated for howto.",
            schema: COMMAND_GENERATION_SCHEMA,
            strict: true,
          }
        : { type: "json_object" },
    },
  };
}

async function usageChatGptHttpError(
  response: Response,
  signal: AbortSignal,
  model: string,
  toolsEnabled: boolean,
): Promise<Error> {
  if (!toolsEnabled) return chatGptHttpError(response, signal);
  let body: unknown;
  try {
    const chunks: Uint8Array<ArrayBufferLike>[] = [];
    for await (const bytes of readChatGptBody(response, signal, 64 * 1024)) chunks.push(bytes);
    body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    ) as unknown;
  } catch {
    // 非 JSON、过大或解码失败只按 HTTP 状态分类，不回显服务正文。
  }
  if (isExplicitUsageToolsUnsupported(body, response.status)) {
    return new UsageToolsUnsupportedError("chatgpt", model);
  }
  const detail = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  return classifyChatGptHttpError(
    response.status,
    typeof detail?.code === "string" ? detail.code : undefined,
  );
}

async function collectChatGptUsageOutput(
  response: Response,
  signal: AbortSignal,
  model: string,
  toolsEnabled: boolean,
): Promise<Record<string, unknown>[]> {
  const fail = () => new AiProviderError("chatgpt", model);
  const completed = new Map<number, Record<string, unknown>>();
  let completedBytes = 0;
  for await (const frame of decodeChatGptEvents(response, signal)) {
    if (
      frame.event !== "" &&
      frame.event !== "message" &&
      frame.event !== "error" &&
      !frame.event.startsWith("response.")
    )
      continue;
    if (frame.data === "[DONE]") break;
    const event: unknown = JSON.parse(frame.data);
    if (!isRecord(event) || typeof event.type !== "string") throw fail();
    if (frame.event !== "" && frame.event !== "message" && frame.event !== event.type) throw fail();
    if (event.type === "error" || event.type === "response.failed") {
      const error =
        isRecord(event.response) && isRecord(event.response.error)
          ? event.response.error
          : isRecord(event.error)
            ? event.error
            : event;
      const code = typeof error.code === "string" ? error.code : undefined;
      const status =
        typeof error.status === "number"
          ? error.status
          : /^(?:invalid_request_error|unsupported_\w+|(?:tools?|function_calling)_not_supported)$/.test(
                code ?? "",
              )
            ? 400
            : undefined;
      if (toolsEnabled && isExplicitUsageToolsUnsupported(error, status)) {
        throw new UsageToolsUnsupportedError("chatgpt", model);
      }
      throw classifyChatGptHttpError(500, code);
    }
    if (
      event.type === "response.incomplete" ||
      event.type === "response.refusal.delta" ||
      event.type === "response.refusal.done" ||
      ((event.type === "response.content_part.added" ||
        event.type === "response.content_part.done") &&
        isRecord(event.part) &&
        event.part.type === "refusal")
    )
      throw fail();
    if (event.type === "response.output_item.done") {
      const index = event.output_index;
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        completed.has(index)
      )
        throw fail();
      const item = readCompletedUsageItem(event.item, model);
      completedBytes += Buffer.byteLength(JSON.stringify(item), "utf8");
      if (completedBytes > MAX_OUTPUT_BYTES) throw fail();
      completed.set(index, item);
    }
    if (event.type === "response.completed") {
      signal.throwIfAborted();
      const final = event.response;
      if (
        !isRecord(final) ||
        final.status !== "completed" ||
        final.error != null ||
        final.incomplete_details != null ||
        !Array.isArray(final.output)
      )
        throw fail();
      const items =
        final.output.length === 0
          ? [...completed].sort(([left], [right]) => left - right).map(([, item]) => item)
          : final.output.map((value: unknown, index: number) => {
              const item = readCompletedUsageItem(value, model);
              const done = completed.get(index);
              // 流中的完整 reasoning（尤其 encrypted_content）以 output_item.done 为准。
              return item.type === "reasoning" && done?.type === "reasoning" && done.id === item.id
                ? done
                : item;
            });
      if (items.length === 0 || Buffer.byteLength(JSON.stringify(items), "utf8") > MAX_OUTPUT_BYTES)
        throw fail();
      return items;
    }
  }
  throw fail();
}

function readCompletedUsageItem(item: unknown, model: string): Record<string, unknown> {
  if (!isRecord(item)) throw new AiProviderError("chatgpt", model);
  if (item.type === "function_call") {
    if (
      typeof item.call_id !== "string" ||
      item.call_id === "" ||
      typeof item.name !== "string" ||
      item.name === "" ||
      typeof item.arguments !== "string" ||
      (item.status !== undefined && item.status !== "completed")
    )
      throw new AiProviderError("chatgpt", model);
  } else {
    readCompletedItemText(item, model);
  }
  return item;
}

async function collectChatGptResponse(
  response: Response,
  signal: AbortSignal,
  model: string,
): Promise<string> {
  const completedItems = new Map<number, string>();
  let completedBytes = 0;
  for await (const frame of decodeChatGptEvents(response, signal)) {
    // 忽略其它协议事件；尤其不把未知事件的正文交给日志或异常消息。
    if (
      frame.event !== "" &&
      frame.event !== "message" &&
      frame.event !== "error" &&
      !frame.event.startsWith("response.")
    ) {
      continue;
    }
    if (frame.data === "[DONE]") break;
    const event: unknown = JSON.parse(frame.data);
    if (!isRecord(event) || typeof event.type !== "string") {
      throw new AiProviderError("chatgpt", model);
    }
    if (frame.event !== "" && frame.event !== "message" && frame.event !== event.type) {
      throw new AiProviderError("chatgpt", model);
    }
    if (event.type === "error" || event.type === "response.failed") {
      const error =
        isRecord(event.response) && isRecord(event.response.error)
          ? event.response.error
          : isRecord(event.error)
            ? event.error
            : event;
      throw classifyChatGptHttpError(500, typeof error.code === "string" ? error.code : undefined);
    }
    if (
      event.type === "response.incomplete" ||
      event.type === "response.refusal.delta" ||
      event.type === "response.refusal.done" ||
      ((event.type === "response.content_part.added" ||
        event.type === "response.content_part.done") &&
        isRecord(event.part) &&
        event.part.type === "refusal")
    ) {
      throw new AiProviderError("chatgpt", model);
    }
    if (event.type === "response.output_item.done") {
      const index = event.output_index;
      if (
        typeof index !== "number" ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        completedItems.has(index)
      ) {
        throw new AiProviderError("chatgpt", model);
      }
      const text = readCompletedItemText(event.item, model);
      completedBytes += Buffer.byteLength(text, "utf8");
      if (completedBytes > MAX_OUTPUT_BYTES) throw new AiProviderError("chatgpt", model);
      completedItems.set(index, text);
    }
    if (event.type === "response.completed") {
      signal.throwIfAborted();
      return readCompletedText(event.response, model, completedItems);
    }
  }
  throw new AiProviderError("chatgpt", model);
}

function readCompletedText(
  response: unknown,
  model: string,
  completedItems: ReadonlyMap<number, string>,
): string {
  const fail = () => new AiProviderError("chatgpt", model);
  if (
    !isRecord(response) ||
    response.status !== "completed" ||
    response.error != null ||
    response.incomplete_details != null ||
    !Array.isArray(response.output)
  ) {
    throw fail();
  }
  // 订阅共享流可能只在 output_item.done 携带完整内容，completed 的 output 为空。
  // 只缓存已完成的项；delta/text.done 不能替代完整项或全局完成事件。
  const text =
    response.output.length === 0
      ? [...completedItems]
          .sort(([left], [right]) => left - right)
          .map(([, value]) => value)
          .join("")
      : response.output.map((item: unknown) => readCompletedItemText(item, model)).join("");
  if (text.trim() === "" || Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) throw fail();
  return text;
}

function readCompletedItemText(item: unknown, model: string): string {
  const fail = () => new AiProviderError("chatgpt", model);
  if (!isRecord(item)) throw fail();
  if (item.type === "reasoning") {
    if (item.status !== undefined && item.status !== "completed") throw fail();
    return "";
  }
  if (
    item.type !== "message" ||
    item.role !== "assistant" ||
    item.status !== "completed" ||
    !Array.isArray(item.content) ||
    (item.phase != null && item.phase !== "final_answer" && item.phase !== "commentary")
  ) {
    throw fail();
  }
  let text = "";
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== "output_text" || typeof part.text !== "string") {
      throw fail();
    }
    if (item.phase !== "commentary") text += part.text;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_OUTPUT_BYTES) throw fail();
  return text;
}

interface ServerSentEvent {
  event: string;
  data: string;
}

async function* decodeChatGptEvents(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  let event = "";
  let data: string[] = [];
  for await (const line of decodeChatGptLines(response, signal)) {
    if (line === "") {
      if (data.length > 0) yield { event, data: data.join("\n") };
      event = "";
      data = [];
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    if (field === "data") data.push(value);
  }
  // EOF 不能补全未以空行结束的事件；没有完整 completed 事件即为失败。
}

async function* decodeChatGptLines(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const bytes of readChatGptBody(response, signal, MAX_STREAM_BYTES)) {
    pending += decoder.decode(bytes, { stream: true });
    let index: number;
    while ((index = pending.search(/[\r\n]/)) >= 0) {
      // CRLF 可以恰好分在两个网络块之间，保留末尾 CR 等下一块。
      if (pending[index] === "\r" && index === pending.length - 1) break;
      const line = pending.slice(0, index);
      const delimiterLength = pending[index] === "\r" && pending[index + 1] === "\n" ? 2 : 1;
      pending = pending.slice(index + delimiterLength);
      yield line;
    }
  }
  pending += decoder.decode();
  if (pending.endsWith("\r")) yield pending.slice(0, -1);
}
