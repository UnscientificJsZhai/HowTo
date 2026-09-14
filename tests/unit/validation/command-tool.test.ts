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

test("use 不把方言相关追加赋值或美元展开当作确定工具", () => {
  assert.equal(candidateUsesRequestedCommand("HOWTO_APPEND+=x git status", "git"), false);
  assert.equal(
    candidateUsesRequestedCommand("HOWTO_APPEND+=x git status", "HOWTO_APPEND+=x"),
    false,
  );
  assert.equal(candidateUsesRequestedCommand("env HOWTO_APPEND+=x git status", "git"), true);
  assert.equal(candidateUsesRequestedCommand("printf '%s' HOWTO_APPEND+=x", "printf"), true);
  for (const expression of ["$=TOOL", "$~TOOL", "$^TOOL", "$+TOOL"]) {
    assert.equal(candidateUsesRequestedCommand(`${expression} status`, expression), false);
    assert.equal(candidateUsesRequestedCommand(`'${expression}' status`, expression), true);
    assert.equal(
      candidateUsesRequestedCommand(`env DATA="${expression}" git status`, "git"),
      false,
    );
  }
});

test("candidateUsesRequestedCommand rejects shell wrappers", () => {
  assert.equal(candidateUsesRequestedCommand('sh -c "git status"', "git"), false);
});

for (const command of [
  "sudo -u root git status",
  "sudo -uroot git status",
  "sudo -nu root git status",
  "sudo --user=root git status",
  "sudo --preserve-env=PATH git status",
  "sudo -- git status",
  "sudo 'FOO=bar' git status",
  'FOO="a b" git status',
  "env -u NAME git status",
  "env -C /tmp git status",
  "env -P /usr/bin git status",
  "env --unset=NAME git status",
  "env -- FOO=bar git status",
  "FOO=bar /usr/bin/sudo -n /usr/bin/env -i BAR=baz git status",
  ">output git status 2>&1",
  "git status # a literal comment",
  "g\\\nit status",
  "git status && printf done",
  "git status | cat",
  "git status; printf done",
]) {
  test(`use git 接受明确工具并正确消费参数：${JSON.stringify(command)}`, () => {
    assert.equal(candidateUsesRequestedCommand(command, "git"), true);
  });
}

for (const command of [
  "sudo -u git id",
  "env -P git /usr/bin/printf HOWTO_REVIEW",
  "env -C git id",
  "sudo -u",
  "sudo --user= git status",
  "sudo --unknown-option git status",
  "sudo -i git status",
  "env --unknown-option git status",
  "env -S 'git status'",
  "env FOO=bar -u git",
  'sudo -u "$USER" git status',
  'env "FOO=$VALUE" git status',
  "'FOO'=bar git status",
  "'FOO=bar' git status",
  "'' git status",
  "git 'status",
  "git status &&",
  "git $(printf status)",
  "git status; (printf done)",
  "printf git | git status",
  "$TOOL status",
  "=git status",
  "noglob git status",
  "not git status",
]) {
  test(`use git 拒绝选项值误认、动态前缀及未知结构：${JSON.stringify(command)}`, () => {
    assert.equal(candidateUsesRequestedCommand(command, "git"), false);
  });
}

test("use 仅精确匹配实际工具 token，不将同名路径视为相同工具", () => {
  assert.equal(candidateUsesRequestedCommand("sudo -u git id", "id"), true);
  assert.equal(candidateUsesRequestedCommand("/usr/bin/git status", "git"), false);
  assert.equal(candidateUsesRequestedCommand("git status", "/usr/bin/git"), false);
  assert.equal(candidateUsesRequestedCommand("'/usr/bin/git' status", "/usr/bin/git"), true);
  assert.equal(candidateUsesRequestedCommand("/custom/git status", "/usr/bin/git"), false);
});

test("use 越过 env 的非 shell 标识符赋值，只匹配后续实际工具", () => {
  for (const assignment of ["1=x", "a-b=c", "a.b=", "a.b=c=d"]) {
    const command = `env '${assignment}' git status`;
    assert.equal(candidateUsesRequestedCommand(command, "git"), true, command);
    assert.equal(candidateUsesRequestedCommand(command, assignment), false, command);
  }
  assert.equal(candidateUsesRequestedCommand("env -- '-a=b' git status", "git"), true);
  assert.equal(candidateUsesRequestedCommand("sudo -n /usr/bin/env 1=x git status", "git"), true);
  assert.equal(candidateUsesRequestedCommand("env 'git=value' id", "git"), false);
  assert.equal(candidateUsesRequestedCommand("env 'git=value' id", "id"), true);
});

test("use 拒绝 env 空名称、动态赋值、缺失工具及不确定的 sudo 赋值", () => {
  for (const command of [
    "env '=x' git status",
    "env -- '=' git status",
    "env 1=x",
    'env A=x "a-b=$VALUE" git status',
    "env a.b=x -- git status",
    "sudo 'a-b=c' git status",
  ]) {
    assert.equal(candidateUsesRequestedCommand(command, "git"), false, command);
  }
});

test("use 拒绝已知 shell 本身及标准路径包装", () => {
  for (const shell of ["sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash"]) {
    for (const executable of [shell, `/bin/${shell}`]) {
      assert.equal(candidateUsesRequestedCommand(`${executable} -c 'git status'`, "git"), false);
      assert.equal(
        candidateUsesRequestedCommand(`${executable} -c 'git status'`, executable),
        false,
      );
      assert.equal(
        candidateUsesRequestedCommand(`sudo ${executable} -c 'git status'`, executable),
        false,
      );
    }
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
