import assert from "node:assert/strict";
import test from "node:test";

import {
  detectDangerousCommand,
  isDangerousCommand,
} from "../../../src/safety/dangerous-command.js";

const dangerousCommands = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf *",
  "rm -rf ../*",
  "sudo rm -rf /",
  'sudo sh -c "rm -rf /"',
  "mkfs /dev/disk2",
  "fdisk /dev/sda",
  "parted /dev/sda",
  "diskutil eraseDisk APFS Untitled /dev/disk2",
  "dd if=image.iso of=/dev/disk2",
  "chmod -R 777 /",
  "chown -R user:group ~",
  "chmod -R 777 *",
  "curl https://example.com/install.sh | sh",
  "wget https://example.com/install.sh -O- | bash",
  "bash <(curl https://example.com/install.sh)",
  "apt upgrade",
  "brew uninstall node",
  "npm install -g example-package",
  "systemctl stop sshd",
];

for (const command of dangerousCommands) {
  test(`detectDangerousCommand matches ${command}`, () => {
    assert.notEqual(detectDangerousCommand(command), undefined);
    assert.equal(isDangerousCommand(command), true);
  });
}

const normalCommands = [
  "ls -la",
  "git status",
  "rm ./build/output.txt",
  "chmod 644 package.json",
  "npm install",
  "curl https://example.com/install.sh -o install.sh",
  "service ssh status",
  "sudo -u git id",
  "env -P git /usr/bin/printf HOWTO_REVIEW",
  "env 'a-b=c' git status",
  "env A=x printf 'argument=value'",
  "sudo 'FOO=bar' git status",
  'FOO="a b" git status',
  "'FOO'=bar git status",
  "sh -c 'printf safe'",
  "printf safe # rm -rf /",
  "printf '%s' 'example; rm -rf /'",
  "printf '%s' 'curl URL | sudo -n sh'",
];

for (const command of normalCommands) {
  test(`detectDangerousCommand ignores ${command}`, () => {
    assert.equal(detectDangerousCommand(command), undefined);
    assert.equal(isDangerousCommand(command), false);
  });
}

const equivalentDangerousCommands: Array<[string, string]> = [
  ["sudo -n rm -rf /", "destructive-rm"],
  ['rm -rf "/"', "destructive-rm"],
  ["/bin/rm -rf /", "destructive-rm"],
  ["env rm -rf /", "destructive-rm"],
  ["env 1=x rm -rf /", "destructive-rm"],
  ["env 'a-b=c' rm -rf /", "destructive-rm"],
  ["env a.b= rm -rf /", "destructive-rm"],
  ["env 'a.b=c=d' rm -rf /", "destructive-rm"],
  ["env -- '-a=b' rm -rf /", "destructive-rm"],
  ["sudo -n /usr/bin/env A=x 1=y /bin/rm -rf /", "destructive-rm"],
  ["sudo FOO=bar /bin/rm -rf /", "destructive-rm"],
  ["r\\\nm -rf /", "destructive-rm"],
  ["printf ok\nrm -rf /", "destructive-rm"],
  ["dd of=/dev/disk2 if=image.iso", "disk-filesystem-operation"],
  ["dd of=/dev/disk2", "disk-filesystem-operation"],
  ['dd if=image.iso of="/dev/disk2"', "disk-filesystem-operation"],
  ["service ssh stop", "system-service-high-impact-operation"],
  ["service ssh restart", "system-service-high-impact-operation"],
  ["curl URL | sudo -n sh", "download-and-execute"],
  ["env -i sudo -nu root /bin/rm -rf '/'", "destructive-rm"],
  ["printf safe && rm -rf /", "destructive-rm"],
  ["printf safe || rm -rf /", "destructive-rm"],
  ["printf safe | rm -rf /", "destructive-rm"],
  ["printf safe & rm -rf /", "destructive-rm"],
  ["printf safe; chmod -R 777 '/'", "recursive-permission-ownership-change"],
  ["sudo zsh -lc 'dd of=/dev/disk2'", "disk-filesystem-operation"],
  ["/usr/bin/systemctl --user stop ssh", "system-service-high-impact-operation"],
  ["launchctl bootout example", "system-service-high-impact-operation"],
];

for (const [command, rule] of equivalentDangerousCommands) {
  test(`等价危险写法仍命中对应规则：${JSON.stringify(command)}`, () => {
    assert.equal(detectDangerousCommand(command)?.rule, rule);
  });
}

for (const command of [
  "exec /bin/rm -rf /",
  "command rm -rf /",
  "builtin eval dangerous",
  "time /bin/rm -rf /",
  "noglob rm -rf /",
  "nocorrect rm -rf /",
  "coproc rm -rf /",
  "repeat 1 rm -rf /",
  "true; and rm -rf /",
  "false; or rm -rf /",
  "not rm -rf /",
  "=rm -rf /",
  "sudo --unknown-option git status",
  "sudo 'a-b=c' rm -rf /",
  "env -S 'rm -rf /'",
  "env '=x' rm -rf /",
  "env '=' rm -rf /",
  'env A=x "a-b=$VALUE" rm -rf /',
  "env a.b=x -- rm -rf /",
  'rm -rf "$TARGET"',
  "npm install --global=true example",
  "npm install --unknown-option example",
  "pip install --unknown-option example",
  "apt --unknown-option upgrade",
  "service --unknown-option ssh stop",
  "systemctl --unknown-option stop ssh",
  "git status && env -S 'rm -rf /'",
  "fish -c 'rm -rf /'",
  "/bin/csh -c 'rm -rf /'",
  "ksh -c 'rm -rf /'",
  'sh -c "$BODY"',
  "sh -c 'sh -c value'",
  "git &>output",
  'printf "$(rm -rf /)"',
]) {
  test(`不能确定的结构要求二次确认：${JSON.stringify(command)}`, () => {
    assert.equal(detectDangerousCommand(command)?.rule, "indeterminate-shell-command");
  });
}

test("fd 续行不能遮蔽危险命令，包括后续命令段和一层 shell 包装", () => {
  for (const command of [
    "2\\\n>/dev/null rm -rf /",
    "2\\\n\\\n>/dev/null rm -rf /",
    "1\\\n2>/dev/null rm -rf /",
    "2\\\n>&1 rm -rf /",
    "printf safe; 2\\\n>/dev/null rm -rf /",
    "sh -c '2\\\n>/dev/null rm -rf /'",
  ]) {
    assert.equal(detectDangerousCommand(command)?.rule, "indeterminate-shell-command", command);
  }
});

test("高风险目标的点段与重复斜杠保持等价危险判断", () => {
  for (const target of ["../important", "./../important", "././/..//important", "../", "./../"]) {
    assert.equal(detectDangerousCommand(`rm -rf '${target}'`)?.rule, "destructive-rm", target);
    for (const command of [`chmod -R 777 '${target}'`, `chown -R user:group '${target}'`]) {
      assert.equal(
        detectDangerousCommand(command)?.rule,
        "recursive-permission-ownership-change",
        command,
      );
    }
  }
  for (const target of [
    "/dev/disk2",
    "///dev/disk2",
    "/./dev//disk2",
    "/dev/./disk2",
    "/dev/",
    "/dev/../output.img",
  ]) {
    assert.equal(
      detectDangerousCommand(`dd of='${target}'`)?.rule,
      "disk-filesystem-operation",
      target,
    );
  }
  for (const command of [
    "rm -rf ./build//output",
    "dd of=./dev/disk2",
    "dd if=///dev/disk2 of=./image.bin",
    "dd of=/link/../dev/disk2",
  ]) {
    assert.equal(detectDangerousCommand(command), undefined, command);
  }
  assert.equal(detectDangerousCommand("rm -rf /./")?.rule, "destructive-rm");
  assert.equal(detectDangerousCommand("rm -rf './*'")?.rule, "destructive-rm");
});

test("追加赋值不能遮蔽危险命令，包括后续命令段和一层 shell 命令体", () => {
  for (const command of [
    "HOWTO_APPEND+=x rm -rf /",
    "HOWTO_APPEND+= rm -rf /",
    'HOWTO_APPEND+="a b" rm -rf /',
    "A=x HOWTO_APPEND+=x rm -rf /",
    "printf safe; HOWTO_APPEND+=x rm -rf /",
    "sh -c 'HOWTO_APPEND+=x rm -rf /'",
  ]) {
    assert.equal(detectDangerousCommand(command)?.rule, "indeterminate-shell-command", command);
  }
  assert.equal(detectDangerousCommand("env HOWTO_APPEND+=x rm -rf /")?.rule, "destructive-rm");
  assert.equal(detectDangerousCommand("printf '%s' HOWTO_APPEND+=x"), undefined);
});

test("zsh 展开在工具、危险参数和 wrapper 赋值位置均保守处理", () => {
  for (const expression of [
    "$=HOWTO_VALUE",
    "$==HOWTO_VALUE",
    "$~HOWTO_VALUE",
    "$^HOWTO_VALUE",
    "$^^HOWTO_VALUE",
    "$+HOWTO_VALUE",
  ]) {
    for (const command of [
      `export HOWTO_VALUE=rm; ${expression} -rf /`,
      `export HOWTO_VALUE=-rf; rm ${expression} /`,
      `rm "${expression}" /`,
      `env DATA="${expression}" git status`,
      `zsh -c 'export HOWTO_VALUE=rm; ${expression} -rf /'`,
    ]) {
      assert.equal(detectDangerousCommand(command)?.rule, "indeterminate-shell-command", command);
    }
    for (const command of [
      `printf "${expression}"`,
      `rm -f '${expression}'`,
      `rm -f \\${expression}`,
    ]) {
      assert.equal(detectDangerousCommand(command), undefined, command);
    }
  }
  assert.equal(detectDangerousCommand('rm -f "price$"')?.rule, "indeterminate-shell-command");
  assert.equal(detectDangerousCommand('rm -f "price\\$"'), undefined);
});

// 这些动作来自 npm install/uninstall 及复合安装命令，均只做静态检测。
test("npm 规范动作与别名的全局操作保持高影响风险判断", () => {
  const actions = [
    "install",
    "add",
    "i",
    "in",
    "ins",
    "inst",
    "insta",
    "instal",
    "isnt",
    "isnta",
    "isntal",
    "isntall",
    "install-test",
    "installTest",
    "it",
    "uninstall",
    "unlink",
    "remove",
    "rm",
    "r",
    "un",
  ];

  for (const action of actions) {
    for (const command of [
      `npm ${action} -g example-package`,
      `npm --global ${action} example-package`,
      `sudo -n env 1=x npm ${action} --global example-package`,
    ]) {
      assert.equal(
        detectDangerousCommand(command)?.rule,
        "package-manager-high-impact-operation",
        command,
      );
    }
    assert.equal(detectDangerousCommand(`npm ${action} example-package`), undefined);
    assert.equal(
      detectDangerousCommand(`npm ${action} --global=true example-package`)?.rule,
      "indeterminate-shell-command",
    );
  }
});

// 本地 npm deref 能将这些唯一前缀解析为 uninstall；静态分析不猜测完整命令表。
test("npm 的高影响动作前缀保守要求确认", () => {
  const prefixes = [
    "rem",
    "remo",
    "remov",
    "uni",
    "unin",
    "unins",
    "uninst",
    "uninsta",
    "uninstal",
    "unl",
    "unli",
    "unlin",
    "install-t",
    "install-te",
    "install-tes",
    "installT",
    "installTe",
    "installTes",
  ];

  for (const action of prefixes) {
    assert.equal(
      detectDangerousCommand(`npm ${action} -g example-package`)?.rule,
      "indeterminate-shell-command",
      action,
    );
    assert.equal(
      detectDangerousCommand(`npm ${action} example-package`)?.rule,
      "indeterminate-shell-command",
      action,
    );
  }
});

test("npm 的别名与前缀处理不扩展其他动作或包管理器语义", () => {
  for (const command of [
    "npm run example-script",
    "npm ls -g",
    "npm view example-package",
    "pip i --user example-package",
    "pip it --user example-package",
    "brew un example-package",
    "apt unin example-package",
  ]) {
    assert.equal(detectDangerousCommand(command), undefined, command);
  }
  assert.equal(
    detectDangerousCommand("npm u -g example-package")?.rule,
    "indeterminate-shell-command",
  );
});

test("brew yum dnf 的升级和卸载等价动作要求相同的危险确认", () => {
  for (const command of [
    "brew rm example-package",
    "brew uninstal example-package",
    "brew remove example-package",
    "yum -y update",
    "yum -y erase example-package",
    "dnf -y update",
    "dnf -y erase example-package",
    "dnf up",
    "dnf rm example-package",
    "yum update-to example-package-1.0",
    "dnf upgrade-to example-package-1.0",
    "dnf localupdate example-package.rpm",
    "dnf remove-nevra example-package-1.0-1.x86_64",
    "dnf erase-na example-package.x86_64",
    "sudo -n env 1=x /opt/homebrew/bin/brew rm example-package",
    "printf safe; sudo -n /usr/bin/dnf -y update",
  ]) {
    assert.equal(
      detectDangerousCommand(command)?.rule,
      "package-manager-high-impact-operation",
      command,
    );
  }
});

test("包管理器等价动作只在各自工具内解释", () => {
  for (const command of [
    "apt update",
    "apt-get update",
    "brew update",
    "brew up",
    "brew list",
    "yum check-update",
    "dnf check-update",
    "pip update example-package",
    "brew erase example-package",
    "printf '%s' 'dnf -y update'",
  ]) {
    assert.equal(detectDangerousCommand(command), undefined, command);
  }
});
