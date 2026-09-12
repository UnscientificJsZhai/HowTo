import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type { CommandCandidateContract, GenerateCommandsRequest } from "../../../src/ai/types.js";
import { createInteractiveSession } from "../../../src/ui/interactive-session.js";

export class SessionFakeTty extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawChanges: boolean[] = [];
  refs = 0;
  constructor(
    public columns = 80,
    public rows = 24,
  ) {
    super();
  }
  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    this.rawChanges.push(enabled);
    return this;
  }
  ref(): this {
    this.refs++;
    return this;
  }
  unref(): this {
    this.refs--;
    return this;
  }
  resize(rows: number): void {
    this.rows = rows;
    this.emit("resize");
  }
}

export function sessionHarness(rows = 24, columns = 80) {
  const input = new SessionFakeTty(columns, rows);
  const output = new SessionFakeTty(columns, rows);
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const session = createInteractiveSession({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream,
  });
  return {
    input,
    output,
    session,
    bytes: () => Buffer.concat(chunks),
    text: () => stripVTControlCharacters(Buffer.concat(chunks).toString()),
    async send(chunk: string | Buffer) {
      input.write(chunk);
      await waitFor(() => input.readableLength === 0, "原始输入没有被排空");
      await nextTurn();
    },
    close() {
      session.dispose();
      input.destroy();
      output.destroy();
    },
  };
}

export async function waitFor(
  condition: () => boolean,
  message: string,
  milliseconds = 2000,
): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await nextTurn();
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

export function testCandidate(command = "printf session-safe"): CommandCandidateContract {
  return { title: "测试命令", command, description: "仅测试回调，不启动命令", placeholders: [] };
}
export function testRequest(): GenerateCommandsRequest {
  return {
    question: "打印测试",
    arguments: [],
    structuredOutput: true,
    outputContract: "",
    safetyConstraints: "",
    systemPrompt: "",
    userPrompt: "",
  };
}
