import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses";

import { getChatGptAccessToken } from "../auth/chatgpt/index.js";
import { classifyChatGptHttpError } from "../auth/chatgpt/errors.js";
import { type AppConfig, ConfigError } from "../config.js";
import { COMMAND_GENERATION_SCHEMA } from "./command-schema.js";
import {
  type ChatGptDependencies,
  chatGptHttpError,
  isRecord,
  readChatGptBody,
  requestChatGptModels,
  runChatGptRequest,
} from "./chatgpt-models.js";
import { AiProviderError } from "./errors.js";
import type { CommandProvider, GenerateCommandsRequest, GenerateCommandsResult } from "./types.js";

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
