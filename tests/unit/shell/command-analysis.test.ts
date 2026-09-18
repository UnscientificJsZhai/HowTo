import assert from "node:assert/strict";
import test from "node:test";
import {
  isShellExecutable,
  parseShellCommand,
  resolveCommandPrefix,
  type ShellSimpleCommand,
} from "../../../src/shell/command-analysis.js";

test("词法分析保留原文位置并区分引用、转义、空参数与动态参数", () => {
  const source = 'FOO="a b" /usr/bin/git \'a;b\' "x\\$y" a\\ b \'\' "$HOME"';
  const words = parsedCommands(source)[0].words;
  assert.deepEqual(
    words.map((word) => word.value),
    ["FOO=a b", "/usr/bin/git", "a;b", "x$y", "a b", "", "$HOME"],
  );
  assert.deepEqual(
    words.map((word) => source.slice(word.start, word.end)),
    ['FOO="a b"', "/usr/bin/git", "'a;b'", '"x\\$y"', "a\\ b", "''", '"$HOME"'],
  );
  assert.deepEqual(
    words.map((word) => word.assignmentOperator),
    ["=", undefined, undefined, undefined, undefined, undefined, undefined],
  );
  assert.deepEqual(
    words.map((word) => word.hasExpansion),
    [false, false, false, false, false, false, true],
  );
});

test("双引号只去除 POSIX 规定的反斜杠转义", () => {
  const words = parsedCommands('printf "a\\qb" "a\\"b" "a\\\\b"')[0].words;
  assert.deepEqual(
    words.map((word) => word.value),
    ["printf", "a\\qb", 'a"b', "a\\b"],
  );
});

test("分隔符只在引用之外生效，续行拼接 token，注释不成为命令", () => {
  const commands = parsedCommands(
    "printf 'a; b|c' # rm -rf /\n\ngit status &&\n git log || printf x | cat & r\\\nm -rf /;",
  );
  assert.deepEqual(
    commands.map((command) => command.words[0].value),
    ["printf", "git", "git", "printf", "cat", "rm"],
  );
  assert.deepEqual(
    commands.map((command) => command.separator),
    ["\n", "&&", "||", "|", "&", ";"],
  );
  assert.equal(parsedCommands("printf a#b\\#c")[0].words[1].value, "a#b#c");
  assert.equal(parsedCommands("printf a\rb")[0].words[1].value, "a\rb");
});

for (const command of [
  ">output git status <input 2>>errors",
  "2>&1 git status 3<&0 4>&-",
  "git >'two words' status 2>errors",
]) {
  test(`普通重定向不参与执行 token 选择：${command}`, () => {
    assert.deepEqual(
      parsedCommands(command)[0].words.map((word) => word.value),
      ["git", "status"],
    );
    assert.equal(executable(command), "git");
  });
}

test("数字 fd 中的续行因 shell 方言歧义保守拒绝", () => {
  for (const prefix of ["2\\\n>", "2\\\n\\\n>>", "1\\\n2>", "1\\\n2\\\n<", "2\\\n>&1 "]) {
    assert.deepEqual(parseShellCommand(`${prefix}output git status`), {
      kind: "unsupported",
      reason: "syntax",
    });
  }
});

test("普通续行和引用或转义的数字保持字面工具与原文位置", () => {
  for (const [source, expected] of [
    ["2\\\n >output git status", "2"],
    ["'2'\\\n>output git status", "2"],
    ['"2\\\n">output git status', "2"],
    ["\\2\\\n>output git status", "2"],
    ["'2\\\n'>output git status", "2\\\n"],
    ["\\\n# comment\ng\\\nit status", "git"],
  ]) {
    assert.equal(executable(source), expected, source);
  }
  const source = "printf 😀 1\\\n2";
  const word = parsedCommands(source)[0].words[2];
  assert.equal(word.value, "12");
  assert.equal(source.slice(word.start, word.end), "1\\\n2");
});

for (const [command, expected] of [
  ['FOO="a b" git status', "git"],
  ["A=$VALUE B=x git status", "git"],
  ["'FOO'=bar git status", "FOO=bar"],
  ["'FOO=bar' git status", "FOO=bar"],
  ["FOO\\=bar git status", "FOO=bar"],
  ["sudo 'FOO=bar' git status", "git"],
  ["sudo FOO=bar /bin/rm -rf /", "/bin/rm"],
  ["env 'FOO=bar' git status", "git"],
  ["FOO=bar /usr/bin/sudo -n /usr/bin/env -i BAZ=value git status", "git"],
  ["sudo -u git id", "id"],
  ["env -P git /usr/bin/printf HOWTO_REVIEW", "/usr/bin/printf"],
  ["sudo -- git status", "git"],
  ["env - git status", "git"],
  ["env -- FOO=bar git status", "git"],
  ["sudo --preserve-env=PATH git status", "git"],
]) {
  test(`前缀只消费确定的赋值与 wrapper 参数：${command}`, () => {
    assert.equal(executable(command), expected);
  });
}

test("shell 前导赋值、sudo argv 与 env argv 分别保留各自的识别边界", () => {
  for (const assignment of ["1=x", "a-b=c", "a.b=c"]) {
    assert.equal(executable(`${assignment} git status`), assignment);
    assertUnsupportedPrefix(`sudo '${assignment}' git status`, "prefix");
    assert.equal(executable(`env '${assignment}' git status`), "git");
  }
  for (const command of [
    "env a.b= git status",
    "env 'a.b=c=d' git status",
    "env 'a b=c' git status",
    "env -- '-a=b' git status",
    "env -- 1=x git status",
    "env A=x a-b=c a.b=d git status",
    "FOO=bar /usr/bin/env -i 1=x /usr/bin/sudo -n git status",
  ]) {
    assert.equal(executable(command), "git", command);
  }
});

test("env 不把空名称、动态赋值或赋值后的选项重新解释为确定工具", () => {
  for (const command of [
    "env '=x' git status",
    "env '=' git status",
    "env -- '=x' git status",
    "env =git git status",
    'env "1=$VALUE" git status',
    'env A=x "a-b=$VALUE" git status',
    'env "$NAME=value" git status',
    "env a.b=x -- git status",
    "env a.b=x -u NAME git status",
  ]) {
    assertUnsupportedPrefix(command, "prefix");
  }
  assertUnsupportedPrefix("env a.b=x", "missing-executable");
  assertUnsupportedPrefix("env -- '-a=b'", "missing-executable");
});

for (const wrapper of [
  {
    name: "sudo",
    zeroShort: "ABbEHknPS",
    oneShort: "CDghpRTu",
    zeroLong: [
      "--askpass",
      "--bell",
      "--background",
      "--preserve-env",
      "--set-home",
      "--reset-timestamp",
      "--non-interactive",
      "--preserve-groups",
      "--stdin",
    ],
    oneLong: [
      "--close-from",
      "--chdir",
      "--group",
      "--host",
      "--prompt",
      "--chroot",
      "--command-timeout",
      "--user",
    ],
  },
  {
    name: "env",
    zeroShort: "iv",
    oneShort: "uCP",
    zeroLong: ["--ignore-environment", "--debug"],
    oneLong: ["--unset", "--chdir"],
  },
]) {
  test(`${wrapper.name} 零参数选项不吞后续工具`, () => {
    for (const option of [...wrapper.zeroShort]
      .map((flag) => `-${flag}`)
      .concat(wrapper.zeroLong)) {
      assert.equal(executable(`${wrapper.name} ${option} git status`), "git", option);
    }
    assert.equal(executable(`${wrapper.name} -${wrapper.zeroShort} git status`), "git");
  });

  test(`${wrapper.name} 单参数选项覆盖分离、粘连、组合、等号与缺参`, () => {
    for (const flag of wrapper.oneShort) {
      for (const option of [`-${flag} git`, `-${flag}git`, `-${wrapper.zeroShort}${flag} git`]) {
        assert.equal(executable(`${wrapper.name} ${option} id`), "id", option);
      }
      assertUnsupportedPrefix(`${wrapper.name} -${flag}`, "missing-argument");
    }
    for (const option of wrapper.oneLong) {
      assert.equal(executable(`${wrapper.name} ${option} git id`), "id", option);
      assert.equal(executable(`${wrapper.name} ${option}=git id`), "id", option);
      assertUnsupportedPrefix(`${wrapper.name} ${option}`, "missing-argument");
      assertUnsupportedPrefix(`${wrapper.name} ${option}= id`, "missing-argument");
    }
  });
}

for (const [command, reason] of [
  ["sudo --not-supported git status", "option"],
  ["sudo -i git status", "option"],
  ["sudo -s git status", "option"],
  ["env -S 'git status'", "option"],
  ["env --split-string='git status'", "option"],
  ["env -0 git status", "option"],
  ["sudo --stdin=git id", "option"],
  ['sudo -u "$USER" git status', "prefix"],
  ['env "FOO=$VALUE" git status', "prefix"],
  ["env FOO=bar -u git", "prefix"],
  ["$TOOL status", "prefix"],
  ["${TOOL} status", "prefix"],
  ["g* status", "prefix"],
  ["'' git status", "prefix"],
  ["/custom/env git status", "prefix"],
  ["exec /bin/rm -rf /", "prefix"],
  ["command rm -rf /", "prefix"],
  ["builtin echo example", "prefix"],
  ["time git status", "prefix"],
  ["noglob rm -rf /", "prefix"],
  ["nocorrect rm -rf /", "prefix"],
  ["coproc rm -rf /", "prefix"],
  ["repeat 1 rm -rf /", "prefix"],
  ["and rm -rf /", "prefix"],
  ["or rm -rf /", "prefix"],
  ["not rm -rf /", "prefix"],
  ["=rm -rf /", "prefix"],
  ["eval text", "prefix"],
  ["source setup.sh", "prefix"],
  [". setup.sh", "prefix"],
  ["if true", "prefix"],
  ["FOO=bar", "missing-executable"],
  ["sudo", "missing-executable"],
  ["env --", "missing-executable"],
] as const) {
  test(`不确定前缀保守失败：${command}`, () => assertUnsupportedPrefix(command, reason));
}

for (const [command, reason] of [
  ["", "missing-executable"],
  ["# only comment", "missing-executable"],
  ["git 'status", "syntax"],
  ["git \\", "syntax"],
  ["git &&", "syntax"],
  ["git || ; id", "syntax"],
  ["git >", "syntax"],
  ["git >; id", "syntax"],
  ["git >output; >other", "syntax"],
  ["git &>output", "syntax"],
  ["git <<EOF", "syntax"],
  ["git <<<text", "syntax"],
  ["git >&$FD", "syntax"],
  ["(git status)", "syntax"],
  ["{ git status; }", "syntax"],
  ["function f() { git status; }", "syntax"],
  ["git $(printf status)", "expansion"],
  ["git `printf status`", "expansion"],
  ["git ${NAME:-status}", "expansion"],
  ["git $'status'", "expansion"],
  ["git <(printf status)", "syntax"],
] as const) {
  test(`超出词法边界明确返回失败原因：${command}`, () => {
    assert.deepEqual(parseShellCommand(command), { kind: "unsupported", reason });
  });
}

test("明确识别现有 shell 包装集合及绝对路径", () => {
  for (const shell of ["sh", "bash", "zsh", "fish", "csh", "tcsh", "ksh", "dash"]) {
    assert.equal(isShellExecutable(shell), true);
    assert.equal(isShellExecutable(`/bin/${shell}`), true);
  }
  assert.equal(isShellExecutable("git"), false);
});

test("zsh 开头等号展开保持动态，引用或转义等号保持字面值", () => {
  assert.equal(parsedCommands("=rm -rf /")[0].words[0].hasExpansion, true);
  for (const command of ["'=rm' -rf /", '"=rm" -rf /', "\\=rm -rf /"]) {
    const word = parsedCommands(command)[0].words[0];
    assert.equal(word.value, "=rm");
    assert.equal(word.hasExpansion, false);
  }
});

test("追加赋值前缀因 shell 方言差异保守拒绝，普通参数与 env argv 保持独立语义", () => {
  for (const command of [
    "HOWTO_APPEND+=x git status",
    "HOWTO_APPEND+= git status",
    'HOWTO_APPEND+="a b" git status',
    "A=x HOWTO_APPEND+=x git status",
    "sudo HOWTO_APPEND+=x git status",
  ]) {
    assertUnsupportedPrefix(command, "prefix");
  }
  assert.equal(executable("env HOWTO_APPEND+=x git status"), "git");
  assert.equal(executable("printf '%s' HOWTO_APPEND+=x"), "printf");
  for (const prefix of ["'HOWTO_APPEND+=x'", "'HOWTO_APPEND'+=x", "HOWTO_APPEND\\+=x"]) {
    assert.equal(executable(`${prefix} git status`), "HOWTO_APPEND+=x");
  }
});

test("未受引用或转义保护的美元表达式不能证明执行前缀是字面工具", () => {
  for (const expression of ["$=TOOL", "$==TOOL", "$~TOOL", "$^TOOL", "$^^TOOL", "$+TOOL", "$"]) {
    for (const command of [`${expression} status`, `"${expression}" status`]) {
      const parsed = parseShellCommand(command);
      const result =
        parsed.kind === "parsed" ? resolveCommandPrefix(parsed.commands[0].words) : parsed;
      assert.equal(result.kind, "unsupported", command);
    }
    assert.equal(executable(`'${expression}' status`), expression);
    assert.equal(executable(`\\${expression} status`), expression);
  }
});

function parsedCommands(command: string): ShellSimpleCommand[] {
  const parsed = parseShellCommand(command);
  assert.equal(parsed.kind, "parsed", command);
  if (parsed.kind !== "parsed") throw new Error("expected parsed command");
  return parsed.commands;
}

function executable(command: string): string {
  const result = resolveCommandPrefix(parsedCommands(command)[0].words);
  assert.equal(result.kind, "parsed", command);
  if (result.kind !== "parsed") throw new Error("expected resolved prefix");
  return result.executable.value;
}

function assertUnsupportedPrefix(command: string, reason: string): void {
  assert.deepEqual(
    resolveCommandPrefix(parsedCommands(command)[0].words),
    { kind: "unsupported", reason },
    command,
  );
}
