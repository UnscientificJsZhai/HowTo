import { StringDecoder } from "node:string_decoder";
import type { UsageLookupResult } from "./types.js";

const HEAD_BYTES = 24 * 1024;
const TAIL_BYTES = 8 * 1024;
const REDACTED = "[redacted]";

export interface SanitizedUsageText {
  text: string;
  credentialsRedacted: boolean;
}

export function sanitizeUsageText(
  value: string,
  credentials: readonly string[] = [],
): SanitizedUsageText {
  const sanitizer = new TerminalOutputSanitizer();
  const redactor = new CredentialRedactor(credentials);
  const text = redactor.write(sanitizer.write(value)) + redactor.finish();
  return { text, credentialsRedacted: redactor.credentialsRedacted };
}

export function sanitizeUsageLookupResult(
  result: UsageLookupResult,
  credentials: readonly string[] = [],
): UsageLookupResult {
  let credentialsRedacted = result.credentialsRedacted;
  const sanitize = (value: string): string => {
    const sanitized = sanitizeUsageText(value, credentials);
    credentialsRedacted ||= sanitized.credentialsRedacted;
    return sanitized.text;
  };
  const redactMetadata = (value: string): string => {
    const redactor = new CredentialRedactor(credentials, false);
    const text = redactor.write(value) + redactor.finish();
    credentialsRedacted ||= redactor.credentialsRedacted;
    return text;
  };
  const seen = new Set<object>();
  const sanitizeRequested = (value: unknown): unknown => {
    if (typeof value === "string") return redactMetadata(value);
    if (typeof value !== "object" || value === null) {
      return typeof value === "number" || typeof value === "boolean" ? value : null;
    }
    if (seen.has(value)) return null;
    seen.add(value);
    const sanitized: unknown = Array.isArray(value)
      ? value.map(sanitizeRequested)
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            redactMetadata(key),
            sanitizeRequested(item),
          ]),
        );
    seen.delete(value);
    return sanitized;
  };
  const requested = sanitizeRequested(result.requested);
  const actualCommand =
    result.actualCommand === null
      ? null
      : {
          executable: redactMetadata(result.actualCommand.executable),
          args: result.actualCommand.args.map(redactMetadata),
          ...(result.actualCommand.argv0 === undefined
            ? {}
            : { argv0: redactMetadata(result.actualCommand.argv0) }),
        };
  const stdout = sanitize(result.stdout);
  const stderr = sanitize(result.stderr);
  return { ...result, requested, actualCommand, stdout, stderr, credentialsRedacted };
}

/** 先流式净化和脱敏，再限制字节数，避免凭据跨 chunk 或截断边界泄漏。 */
export class UsageOutputCapture {
  private readonly decoder = new StringDecoder("utf8");
  private readonly sanitizer = new TerminalOutputSanitizer();
  private readonly redactor: CredentialRedactor;
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private totalBytes = 0;
  private result?: SanitizedUsageText & { truncated: boolean };

  constructor(credentials: readonly string[] = []) {
    this.redactor = new CredentialRedactor(credentials);
  }

  write(chunk: Buffer): void {
    if (this.result !== undefined) return;
    this.capture(this.redactor.write(this.sanitizer.write(this.decoder.write(chunk))));
  }

  finish(): SanitizedUsageText & { truncated: boolean } {
    if (this.result !== undefined) return this.result;
    this.capture(this.redactor.write(this.sanitizer.write(this.decoder.end())));
    this.capture(this.redactor.finish());
    const truncated = this.totalBytes > HEAD_BYTES + TAIL_BYTES;
    // 不让截断切开 UTF-8 字符；完整输出按原顺序拼回，截断输出分别修剪边界。
    const text = truncated
      ? new StringDecoder("utf8").write(this.head) + decodeUtf8Tail(this.tail)
      : Buffer.concat([this.head, this.tail]).toString("utf8");
    this.result = {
      text,
      truncated,
      credentialsRedacted: this.redactor.credentialsRedacted,
    };
    return this.result;
  }

  private capture(text: string): void {
    if (text === "") return;
    let bytes = Buffer.from(text, "utf8");
    this.totalBytes += bytes.length;
    if (this.head.length < HEAD_BYTES) {
      const count = Math.min(HEAD_BYTES - this.head.length, bytes.length);
      this.head = Buffer.concat([this.head, bytes.subarray(0, count)]);
      bytes = bytes.subarray(count);
    }
    if (bytes.length > 0) {
      this.tail = Buffer.from(
        bytes.length >= TAIL_BYTES
          ? bytes.subarray(-TAIL_BYTES)
          : Buffer.concat([this.tail, bytes]).subarray(-TAIL_BYTES),
      );
    }
  }
}

class CredentialRedactor {
  readonly credentials: string[];
  readonly lookbehind: number;
  credentialsRedacted = false;
  private pending = "";

  constructor(credentials: readonly string[], clean = true) {
    this.credentials = [
      ...new Set((clean ? credentials.map(cleanCredential) : credentials).filter(Boolean)),
    ].sort((left, right) => right.length - left.length);
    this.lookbehind = Math.max(0, ...this.credentials.map((value) => value.length - 1));
  }

  write(text: string): string {
    this.pending += text;
    return this.flush(Math.max(0, this.pending.length - this.lookbehind));
  }

  finish(): string {
    return this.flush(this.pending.length);
  }

  private flush(boundary: number): string {
    let text = "";
    let index = 0;
    while (index < boundary) {
      const credential = this.credentials.find((value) => this.pending.startsWith(value, index));
      if (credential !== undefined) {
        text += REDACTED;
        this.credentialsRedacted = true;
        index += credential.length;
      } else {
        const codePoint = this.pending.codePointAt(index)!;
        const width = codePoint > 0xffff ? 2 : 1;
        text += this.pending.slice(index, index + width);
        index += width;
      }
    }
    this.pending = this.pending.slice(index);
    return text;
  }
}

class TerminalOutputSanitizer {
  private state: "text" | "escape" | "intermediate" | "csi" | "string" | "string-escape" = "text";
  private afterCarriageReturn = false;

  write(value: string): string {
    let text = "";
    for (const char of value) {
      const code = char.codePointAt(0)!;
      if (this.state === "string" || this.state === "string-escape") {
        if (code === 0x07 || code === 0x9c || (this.state === "string-escape" && char === "\\")) {
          this.state = "text";
        } else {
          this.state = code === 0x1b ? "string-escape" : "string";
        }
        continue;
      }
      if (this.state === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.state = "text";
        else if (code === 0x1b) this.state = "escape";
        continue;
      }
      if (this.state === "escape" || this.state === "intermediate") {
        if (this.state === "escape" && char === "[") this.state = "csi";
        else if (this.state === "escape" && "]PX^_".includes(char)) this.state = "string";
        else if (code >= 0x20 && code <= 0x2f) this.state = "intermediate";
        else this.state = code === 0x1b ? "escape" : "text";
        continue;
      }
      if (code === 0x1b) this.state = "escape";
      else if (code === 0x9b) this.state = "csi";
      else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) this.state = "string";
      else if (char === "\r") {
        text += "\n";
        this.afterCarriageReturn = true;
        continue;
      } else if (char === "\n") {
        if (!this.afterCarriageReturn) text += char;
      } else if (
        char === "\t" ||
        (code >= 0x20 &&
          !(code >= 0x7f && code <= 0x9f) &&
          !(code >= 0x202a && code <= 0x202e) &&
          !(code >= 0x2066 && code <= 0x2069))
      ) {
        text += char;
      }
      this.afterCarriageReturn = false;
    }
    return text;
  }
}

function cleanCredential(value: string): string {
  return new TerminalOutputSanitizer().write(value);
}

function decodeUtf8Tail(value: Buffer): string {
  let start = 0;
  while (start < value.length && (value[start] & 0xc0) === 0x80) start += 1;
  return value.subarray(start).toString("utf8");
}
