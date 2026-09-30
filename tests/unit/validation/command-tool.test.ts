import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  candidateUsesRequestedCommand,
  checkCommandInPath,
  validateUseCommandCandidates,
} from "../../../src/validation/command-tool.js";
import { AiResponseValidationError } from "../../../src/validation/ai-response.js";

test("candidateUsesRequestedCommand accepts direct requested command", () => {
  assert.equal(candidateUsesRequestedCommand("git status", "git"), true);
});

test("candidateUsesRequestedCommand accepts sudo and environment prefixes", () => {
  assert.equal(candidateUsesRequestedCommand("FOO=bar sudo git status", "git"), true);
});

test("candidateUsesRequestedCommand accepts env prefixes", () => {
  assert.equal(candidateUsesRequestedCommand("env FOO=bar git status", "git"), true);
});

test("use git 接受明确工具并正确消费 sudo/env 参数", () => {
  assert.equal(candidateUsesRequestedCommand("sudo -u root git status", "git"), true);
  assert.equal(candidateUsesRequestedCommand("env -P /usr/bin git status", "git"), true);
});

test("use git 拒绝选项值误认与动态前缀", () => {
  assert.equal(candidateUsesRequestedCommand("sudo -u git id", "git"), false);
  assert.equal(candidateUsesRequestedCommand("sudo -u", "git"), false);
});

test("use 仅精确匹配实际工具 token，不将同名路径视为相同工具", () => {
  assert.equal(candidateUsesRequestedCommand("sudo -u git id", "id"), true);
  assert.equal(candidateUsesRequestedCommand("/usr/bin/git status", "git"), false);
  assert.equal(candidateUsesRequestedCommand("git status", "/usr/bin/git"), false);
  assert.equal(candidateUsesRequestedCommand("'/usr/bin/git' status", "/usr/bin/git"), true);
  assert.equal(candidateUsesRequestedCommand("/custom/git status", "/usr/bin/git"), false);
});

test("use 拒绝已知 shell 本身及标准路径包装", () => {
  for (const executable of ["sh", "bash", "/bin/sh", "/bin/bash", "ash", "/bin/ash", "hush"]) {
    assert.equal(candidateUsesRequestedCommand(`${executable} -c 'git status'`, "git"), false);
    assert.equal(candidateUsesRequestedCommand(`${executable} -c 'git status'`, executable), false);
  }
});

test("use 不能把带续行的歧义 fd 当作请求工具", () => {
  for (const useCommand of ["2", "git"]) {
    assert.equal(candidateUsesRequestedCommand("2\\\n>output git status", useCommand), false);
  }
});

for (const [command, names] of [
  ["git log -n {{count}}", ["count"]],
  ["git '{{path}}'", ["path"]],
  ["git \\{{path}}", ["path"]],
  ["git status >{{dest}}", ["dest"]],
  ["git show | head -n {{count}}", ["count"]],
  ["git status # {{note}}", ["note"]],
  ["git show {{path}}{{path}}", ["path"]],
  ["git show {{0-path_name}}", ["0-path_name"]],
  ['# 👩‍💻\ngit show "{{path}}"', ["path"]],
] as const) {
  test(`use 仅分析工具之后的已声明模板，保留字面边界：${JSON.stringify(command)}`, () => {
    assert.equal(candidateUsesRequestedCommand(command, "git", names), true);
  });
}

for (const [command, names] of [
  ["{{tool}} status", ["tool"]],
  ["gi{{part}}t status", ["part"]],
  ["sudo -u {{user}} git status", ["user"]],
  ["sudo FOO={{value}} git status", ["value"]],
  ["A={{value}} git status", ["value"]],
  [">{{dest}} git status", ["dest"]],
  ["#{{comment}}\ngit status", ["comment"]],
  ["'{{tool}}' status", ["tool"]],
  ["\\{{tool}} status", ["tool"]],
] as const) {
  test(`use 拒绝首工具及之前的动态模板：${JSON.stringify(command)}`, () => {
    assert.equal(candidateUsesRequestedCommand(command, "git", names), false);
  });
}

test("use 模板替身不能碰巧匹配指定工具，默认也不启用模板替身", () => {
  for (const command of ["{{tool}} status", "'{{tool}}' status", "\\{{tool}} status"]) {
    assert.equal(candidateUsesRequestedCommand(command, "xxxxxxxx", ["tool"]), false);
  }
  assert.equal(candidateUsesRequestedCommand("git {{count}}", "git"), false);
  assert.equal(candidateUsesRequestedCommand("git {{count}}", "git", ["different"]), false);
});

test("validateUseCommandCandidates rejects commands that do not use requested tool", () => {
  assert.throws(
    () =>
      validateUseCommandCandidates(
        {
          commands: [
            {
              title: "List files",
              command: "ls",
              description: "List files",
              dangerous: false,
              dangerReason: "",
              placeholders: [],
            },
          ],
        },
        "git",
      ),
    AiResponseValidationError,
  );
});

test("PATH 检查只接受可执行普通文件并跟随符号链接", (t) => {
  const root = mkdtempSync(join(tmpdir(), "howto-path 空格-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const command = join(root, "tool");
  mkdirSync(command);
  assert.equal(checkCommandInPath("tool", { PATH: root }).found, false);
  rmSync(command, { recursive: true });
  writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
  assert.equal(checkCommandInPath("tool", { PATH: root }).found, false);
  chmodSync(command, 0o700);
  assert.equal(checkCommandInPath("tool", { PATH: root }).resolvedPath, command);
  symlinkSync(command, join(root, "linked"));
  assert.equal(checkCommandInPath("linked", { PATH: root }).found, true);
});
test("PATH 空段按 POSIX 语义搜索当前目录", (t) => {
  const root = mkdtempSync(join(tmpdir(), "howto-path-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previousCwd = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(previousCwd));
  const name = "local-tool";
  writeFileSync(join(root, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  for (const PATH of ["", ":/does-not-exist", "/does-not-exist:", "/none::/missing"]) {
    assert.equal(checkCommandInPath(name, { PATH }).found, true, JSON.stringify(PATH));
  }
});
