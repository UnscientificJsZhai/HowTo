import { posix } from "node:path";

export interface ShellWord {
  value: string;
  start: number;
  end: number;
  hasExpansion: boolean;
  isAssignment: boolean;
}

export type ShellSeparator = ";" | "\n" | "&&" | "||" | "|" | "&";

export interface ShellSimpleCommand {
  words: ShellWord[];
  separator?: ShellSeparator;
}

export interface UnsupportedShellCommand {
  kind: "unsupported";
  reason: "syntax" | "expansion" | "prefix" | "option" | "missing-argument" | "missing-executable";
}

export type ShellParseResult =
  { kind: "parsed"; commands: ShellSimpleCommand[] } | UnsupportedShellCommand;
export type ShellPrefixResult =
  { kind: "parsed"; executable: ShellWord; args: ShellWord[] } | UnsupportedShellCommand;

type Token =
  | { kind: "word"; word: ShellWord }
  | { kind: "separator"; separator: ShellSeparator }
  | { kind: "redirect"; needsTarget: boolean };

type LexResult = { kind: "parsed"; tokens: Token[] } | UnsupportedShellCommand;

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash"]);
const REINTERPRETING_PREFIXES = new Set([
  "command",
  "exec",
  "builtin",
  "time",
  "noglob",
  "nocorrect",
  "eval",
  "source",
  ".",
]);
const RESERVED_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "repeat",
  "and",
  "or",
  "not",
  "!",
]);
const WRAPPER_PATHS = new Set([
  "sudo",
  "env",
  "/usr/bin/sudo",
  "/bin/sudo",
  "/usr/bin/env",
  "/bin/env",
]);

const SUDO_ZERO_SHORT = new Set("ABbEHknPS");
const SUDO_ONE_SHORT = new Set("CDghpRTu");
const SUDO_ZERO_LONG = new Set([
  "--askpass",
  "--bell",
  "--background",
  "--preserve-env",
  "--set-home",
  "--reset-timestamp",
  "--non-interactive",
  "--preserve-groups",
  "--stdin",
]);
const SUDO_ONE_LONG = new Set([
  "--close-from",
  "--chdir",
  "--group",
  "--host",
  "--prompt",
  "--chroot",
  "--command-timeout",
  "--user",
]);
const ENV_ZERO_SHORT = new Set("iv");
const ENV_ONE_SHORT = new Set("uCP");
const ENV_ZERO_LONG = new Set(["--ignore-environment", "--debug"]);
const ENV_ONE_LONG = new Set(["--unset", "--chdir"]);

export function isShellExecutable(value: string): boolean {
  return SHELLS.has(posix.basename(value));
}

export function parseShellCommand(command: string): ShellParseResult {
  const lexed = lexShellCommand(command);
  if (lexed.kind === "unsupported") return lexed;

  const commands: ShellSimpleCommand[] = [];
  let words: ShellWord[] = [];
  let needsCommand = false;
  let hasRedirection = false;
  for (let index = 0; index < lexed.tokens.length; index += 1) {
    const token = lexed.tokens[index];
    if (token.kind === "word") {
      words.push(token.word);
      needsCommand = false;
    } else if (token.kind === "redirect") {
      hasRedirection = true;
      if (token.needsTarget) {
        const target = lexed.tokens[index + 1];
        if (target?.kind !== "word") return unsupported("syntax");
        index += 1;
      }
    } else {
      if (words.length === 0) {
        if (hasRedirection) return unsupported("syntax");
        if (token.separator === "\n") continue;
        return unsupported("syntax");
      }
      commands.push({ words, separator: token.separator });
      words = [];
      hasRedirection = false;
      needsCommand =
        token.separator === "&&" || token.separator === "||" || token.separator === "|";
    }
  }
  if (needsCommand) return unsupported("syntax");
  if (words.length === 0 && hasRedirection) return unsupported("syntax");
  if (words.length > 0) commands.push({ words });
  return commands.length > 0 ? { kind: "parsed", commands } : unsupported("missing-executable");
}

export function resolveCommandPrefix(words: readonly ShellWord[]): ShellPrefixResult {
  let index = 0;
  while (words[index]?.isAssignment) index += 1;

  while (index < words.length) {
    const word = words[index];
    if (word.hasExpansion || word.value === "" || word.value.startsWith("-"))
      return unsupported("prefix");
    const name = posix.basename(word.value);
    if (REINTERPRETING_PREFIXES.has(name) || RESERVED_WORDS.has(word.value))
      return unsupported("prefix");
    if (name !== "sudo" && name !== "env") {
      return { kind: "parsed", executable: word, args: words.slice(index + 1) };
    }
    if (!WRAPPER_PATHS.has(word.value)) return unsupported("prefix");
    const skipped = skipWrapperOptions(words, index + 1, name);
    if (typeof skipped !== "number") return skipped;
    index = skipped;
    // wrapper 按 argv 识别赋值；env 的非空名称不受 shell 标识符规则限制。
    // sudo 保留 NAME= 白名单，其他含等号形式及动态赋值不推测为工具。
    while (words[index] !== undefined) {
      const assignment = words[index];
      const equals = assignment.value.indexOf("=");
      if (equals < 0) break;
      if (
        assignment.hasExpansion ||
        (name === "env" ? equals === 0 : !ASSIGNMENT.test(assignment.value))
      )
        return unsupported("prefix");
      index += 1;
    }
  }
  return unsupported("missing-executable");
}

function skipWrapperOptions(
  words: readonly ShellWord[],
  start: number,
  wrapper: "sudo" | "env",
): number | UnsupportedShellCommand {
  const zeroShort = wrapper === "sudo" ? SUDO_ZERO_SHORT : ENV_ZERO_SHORT;
  const oneShort = wrapper === "sudo" ? SUDO_ONE_SHORT : ENV_ONE_SHORT;
  const zeroLong = wrapper === "sudo" ? SUDO_ZERO_LONG : ENV_ZERO_LONG;
  const oneLong = wrapper === "sudo" ? SUDO_ONE_LONG : ENV_ONE_LONG;
  let index = start;
  while (index < words.length) {
    const word = words[index];
    if (word.hasExpansion) return unsupported("prefix");
    const option = word.value;
    if (option === "--") return index + 1;
    if (option === "-" && wrapper === "env") return index + 1;
    if (!option.startsWith("-") || option === "-") return index;
    let needsArgument = false;
    if (option.startsWith("--")) {
      const equals = option.indexOf("=");
      const name = equals < 0 ? option : option.slice(0, equals);
      if (zeroLong.has(name)) {
        if (equals >= 0 && !(wrapper === "sudo" && name === "--preserve-env"))
          return unsupported("option");
      } else if (oneLong.has(name)) {
        if (equals >= 0) {
          if (option.slice(equals + 1) === "") return unsupported("missing-argument");
        } else {
          needsArgument = true;
        }
      } else {
        return unsupported("option");
      }
    } else {
      for (let offset = 1; offset < option.length; offset += 1) {
        const flag = option[offset];
        if (zeroShort.has(flag)) continue;
        if (!oneShort.has(flag)) return unsupported("option");
        needsArgument = offset === option.length - 1;
        break;
      }
    }
    index += 1;
    if (needsArgument) {
      const argument = words[index];
      if (argument === undefined || argument.value === "") return unsupported("missing-argument");
      if (argument.hasExpansion) return unsupported("prefix");
      index += 1;
    }
  }
  return index;
}

function lexShellCommand(command: string): LexResult {
  const tokens: Token[] = [];
  let index = 0;
  while (index < command.length) {
    const char = command[index];
    if (char === " " || char === "\t") {
      index += 1;
      continue;
    }
    if (char === "\\" && command[index + 1] === "\n") {
      index += 2;
      continue;
    }
    if (char === "#") {
      while (index < command.length && command[index] !== "\n") index += 1;
      continue;
    }
    if (";\n&|".includes(char)) {
      if (char === "&" && command[index + 1] === ">") return unsupported("syntax");
      const pair = command.slice(index, index + 2);
      const separator = pair === "&&" || pair === "||" ? pair : (char as ShellSeparator);
      tokens.push({ kind: "separator", separator });
      index += separator.length;
      continue;
    }
    if ("(){}".includes(char)) return unsupported("syntax");

    const redirect = /^(?:\d+)?(?:>>|[<>])/.exec(command.slice(index));
    if (redirect !== null) {
      index += redirect[0].length;
      if (command[index] === "<" || command[index] === ">" || command[index] === "(")
        return unsupported("syntax");
      if (command[index] === "&") {
        const descriptor = /^&(?:\d+|-)(?=$|[ \t\n;&|<>])/.exec(command.slice(index));
        if (descriptor === null) return unsupported("syntax");
        index += descriptor[0].length;
        tokens.push({ kind: "redirect", needsTarget: false });
      } else {
        tokens.push({ kind: "redirect", needsTarget: true });
      }
      continue;
    }

    const word = readWord(command, index);
    if (word.kind === "unsupported") return word;
    tokens.push({ kind: "word", word: word.word });
    index = word.word.end;
  }
  return { kind: "parsed", tokens };
}

function readWord(
  command: string,
  start: number,
): { kind: "parsed"; word: ShellWord } | UnsupportedShellCommand {
  let index = start;
  let value = "";
  let quote: "'" | '"' | undefined;
  let hasExpansion = false;
  let assignmentEligible = true;
  let isAssignment = false;
  while (index < command.length) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else value += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      const next = command[index + 1];
      if (next === undefined) return unsupported("syntax");
      if (next === "\n") {
        index += 2;
        continue;
      }
      if (quote === undefined || '$`"\\'.includes(next)) {
        value += next;
        assignmentEligible = false;
        index += 2;
        continue;
      }
      value += char;
      index += 1;
      continue;
    }
    if (quote === '"' && char === '"') {
      quote = undefined;
      index += 1;
      continue;
    }
    if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
      assignmentEligible = false;
      index += 1;
      continue;
    }
    if (char === "`") return unsupported("expansion");
    if (char === "$") {
      const next = command[index + 1];
      if (next === "(" || next === "'" || next === '"') return unsupported("expansion");
      if (next === "{") {
        const parameter = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}/.exec(command.slice(index));
        if (parameter === null) return unsupported("expansion");
        value += parameter[0];
        hasExpansion = true;
        assignmentEligible = false;
        index += parameter[0].length;
        continue;
      }
      if (next !== undefined && /[A-Za-z_0-9@*#?$!-]/.test(next)) hasExpansion = true;
    }
    if (quote === undefined) {
      if (" \t\n;&|<>".includes(char)) break;
      if ("(){}".includes(char)) return unsupported("syntax");
      if (
        "*?[".includes(char) ||
        (char === "~" && value === "") ||
        (char === "=" && value === "" && assignmentEligible)
      )
        hasExpansion = true;
      if (char === "=" && assignmentEligible && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
        isAssignment = true;
    }
    value += char;
    index += 1;
  }
  if (quote !== undefined) return unsupported("syntax");
  return { kind: "parsed", word: { value, start, end: index, hasExpansion, isAssignment } };
}

function unsupported(reason: UnsupportedShellCommand["reason"]): UnsupportedShellCommand {
  return { kind: "unsupported", reason };
}
