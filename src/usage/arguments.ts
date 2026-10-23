import { parseLiteralArguments as parseShellLiteralArguments } from "../shell/command-analysis.js";
import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";
import type { UsageLookupArguments } from "./types.js";

const INVALID_ARGUMENTS_MESSAGE = "Invalid usage lookup arguments";
const ARGUMENT_KEYS = new Set(["args", "purpose", "dangerous", "dangerReason"]);

export function validateUsageLookupArguments(value: unknown): UsageLookupArguments {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(INVALID_ARGUMENTS_MESSAGE);
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => !ARGUMENT_KEYS.has(key)) ||
    !isSafeString(record.purpose) ||
    record.purpose.trim() === "" ||
    typeof record.dangerous !== "boolean" ||
    !isSafeString(record.dangerReason) ||
    (record.dangerous ? record.dangerReason.trim() === "" : record.dangerReason !== "")
  ) {
    throw new Error(INVALID_ARGUMENTS_MESSAGE);
  }
  return {
    args: validateUsageArgumentList(record.args),
    purpose: record.purpose,
    dangerous: record.dangerous,
    dangerReason: record.dangerReason,
  };
}

export function validateUsageArgumentList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error(INVALID_ARGUMENTS_MESSAGE);
  }
  const args: string[] = [];
  for (const argument of value) {
    if (!isSafeString(argument)) throw new Error(INVALID_ARGUMENTS_MESSAGE);
    args.push(argument);
  }
  return args;
}

export function parseLiteralArguments(text: string): string[] {
  return validateUsageArgumentList(parseShellLiteralArguments(text));
}

export function formatLiteralArguments(args: readonly string[]): string {
  return args.map(quoteLiteralArgument).join(" ");
}

export function formatUsageCommand(executable: string, args: readonly string[]): string {
  return formatLiteralArguments([executable, ...args]);
}

function quoteLiteralArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isSafeString(value: unknown): value is string {
  if (typeof value !== "string" || hasUnsafeTerminalControlCharacters(value)) return false;
  // Node 会把未配对代理项编码为替代字符；拒绝它们才能保证回传 argv 与实际执行一致。
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}
