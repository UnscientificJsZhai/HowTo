import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateUsesRequestedCommand,
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

test("candidateUsesRequestedCommand rejects shell wrappers", () => {
  assert.equal(candidateUsesRequestedCommand('sh -c "git status"', "git"), false);
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
  for (const executable of ["sh", "bash", "/bin/sh", "/bin/bash"]) {
    assert.equal(candidateUsesRequestedCommand(`${executable} -c 'git status'`, "git"), false);
    assert.equal(candidateUsesRequestedCommand(`${executable} -c 'git status'`, executable), false);
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
              placeholders: [],
            },
          ],
        },
        "git",
      ),
    AiResponseValidationError,
  );
});
