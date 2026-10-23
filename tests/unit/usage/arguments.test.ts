import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLiteralArguments,
  formatUsageCommand,
  parseLiteralArguments,
  validateUsageLookupArguments,
} from "../../../src/usage/arguments.js";
import { resolveUsageCommandDanger } from "../../../src/usage/risk.js";

test("符号链接的原调用名与真实程序任一风险均保留", () => {
  const noAiRisk = { dangerous: false, dangerReason: "" };
  assert.ok(
    resolveUsageCommandDanger("npm", "/opt/npm-cli.js", ["uninstall", "-g", "pkg"], noAiRisk),
  );
  assert.ok(resolveUsageCommandDanger("local-alias", "/bin/rm", ["-rf", "/"], noAiRisk));
  assert.equal(
    resolveUsageCommandDanger("npm", "/opt/npm-cli.js", ["--help"], noAiRisk)?.rule,
    "indeterminate-shell-command",
  );
  assert.match(
    resolveUsageCommandDanger("tool", "/opt/tool", ["--help"], {
      dangerous: true,
      dangerReason: "可能修改配置",
    })?.reason ?? "",
    /可能修改配置/,
  );
});

test("查询参数校验保留字面 argv，复制数组并严格验证危险标记", () => {
  const args = ["nested", "--help", "", "$(touch marker)", ";", "x\r\ny"];
  const request = { args, purpose: "查询多层帮助", dangerous: false, dangerReason: "" };
  const validated = validateUsageLookupArguments(request);
  assert.deepEqual(validated, request);
  assert.notEqual(validated.args, args);
  assert.deepEqual(
    validateUsageLookupArguments({ ...request, dangerous: true, dangerReason: "可能修改配置" }),
    { ...request, dangerous: true, dangerReason: "可能修改配置" },
  );
});

test("查询参数异常只返回固定错误，不回显非法内容", () => {
  const valid = { args: ["--help"], purpose: "查帮助", dangerous: false, dangerReason: "" };
  const sparse: unknown[] = [];
  sparse.length = 1;
  for (const value of [
    null,
    [],
    "FAKE_SECRET",
    { ...valid, args: "--help" },
    { ...valid, args: [2] },
    { ...valid, args: sparse },
    { ...valid, args: ["FAKE_SECRET\0"] },
    { ...valid, args: ["\ud800"] },
    { ...valid, args: ["\udc00"] },
    { ...valid, purpose: " " },
    { ...valid, purpose: "\u001b[2JFAKE_SECRET" },
    { ...valid, dangerous: "false" },
    { ...valid, dangerous: true },
    { ...valid, dangerReason: "FAKE_SECRET" },
    { ...valid, executable: "unexpected" },
    { ...valid, dangerReason: undefined },
  ]) {
    assert.throws(() => validateUsageLookupArguments(value), {
      message: "Invalid usage lookup arguments",
    });
  }
});

test("严格编辑入口保留引号、转义、空参数和多层命令", () => {
  assert.deepEqual(parseLiteralArguments("  \t "), []);
  assert.deepEqual(
    parseLiteralArguments("workspace deployment --help \"two words\" '' a\\ b 'a;b' \"x\\$y\""),
    ["workspace", "deployment", "--help", "two words", "", "a b", "a;b", "x$y"],
  );
  assert.deepEqual(parseLiteralArguments("'$(whoami)' '\\' '\"' '\n' '\r'"), [
    "$(whoami)",
    "\\",
    '"',
    "\n",
    "\r",
  ]);
});

test("严格编辑入口拒绝操作符、重定向、注释和展开，不吞掉输入片段", () => {
  for (const source of [
    "help | cat",
    "help && cat",
    "help || cat",
    "help &",
    "help ; cat",
    "help\ncat",
    "help > result",
    "help 2>>result",
    "help 2>&1",
    "help &>result",
    "help <input",
    "help <(cat)",
    "help # comment",
    "help $HOME",
    'help "$HOME"',
    "help $(cat)",
    "help `cat`",
    "help ${HOME}",
    "help $'word'",
    "help ~",
    "help HOME=~user",
    "help *",
    "help [ab]",
    "help a?",
    "help {a,b}",
    "help =git",
    "help \\\nother",
    "help 'unclosed",
    "help \\",
    "help '\0'",
    "help '\ud800'",
  ]) {
    assert.throws(() => parseLiteralArguments(source), source);
  }
});

test("格式化命令可严格解析回相同字面参数，程序名不可被拼成 shell 代码", () => {
  const executable = "/tmp/a program's tool";
  const args = ["", "a'b", 'a"b', "$HOME", "x;y", ">out", "#help", "~", "=git", "你好😀", "\r\n"];
  assert.deepEqual(parseLiteralArguments(formatLiteralArguments(args)), args);
  assert.deepEqual(parseLiteralArguments(formatUsageCommand(executable, args)), [
    executable,
    ...args,
  ]);
});
