import assert from "node:assert/strict";
import test from "node:test";

import { detectRuntimeEnvironment } from "../../../src/shell/runtime-environment.js";

test("Linux 环境优先读取 /etc/os-release，只保留发行版与执行上下文", () => {
  const paths: string[] = [];
  const environment = detectRuntimeEnvironment({
    platform: "linux",
    kernelRelease: "6.8.0",
    env: { SHELL: "/bin/sh", HOWTO_OPENAI_API_KEY: "ENV_SECRET_SENTINEL" },
    readOsRelease(path) {
      paths.push(path);
      return 'PRETTY_NAME="Ubuntu 24.04 LTS"\nNAME=Ubuntu\nPRIVATE_VALUE=FILE_SECRET_SENTINEL';
    },
  });

  assert.deepEqual(environment, {
    operatingSystem: "Linux",
    kernelRelease: "6.8.0",
    distribution: "Ubuntu 24.04 LTS",
    executionShell: "/bin/sh",
  });
  assert.deepEqual(paths, ["/etc/os-release"]);
});

test("Linux 主发行版文件缺失时使用 /usr/lib/os-release", () => {
  const paths: string[] = [];
  const environment = detectRuntimeEnvironment({
    platform: "linux",
    env: {},
    readOsRelease(path) {
      paths.push(path);
      if (path === "/etc/os-release") throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return "NAME='Alpine Linux'\nVERSION_ID=3.20.0";
    },
  });

  assert.equal(environment.distribution, "Alpine Linux 3.20.0");
  assert.deepEqual(paths, ["/etc/os-release", "/usr/lib/os-release"]);
});

for (const [content, expected] of [
  ["# comment\r\nID=debian\r\nVERSION_ID='12'", "debian 12"],
  ['PRETTY_NAME=""\nNAME=Fedora\nVERSION_ID=40', "Fedora 40"],
  ['PRETTY_NAME="Old"\nPRETTY_NAME="New"', "New"],
  [String.raw`PRETTY_NAME="Test \"Linux\" \\ \$HOME"`, 'Test "Linux" \\ $HOME'],
  ['PRETTY_NAME="$(printf sentinel)"', "$(printf sentinel)"],
  ['PRETTY_NAME="unterminated\nUNRELATED=value', null],
  ["", null],
] as const) {
  test(`发行版字段按文本解析并处理引号、回退或未知值：${JSON.stringify(content)}`, () => {
    const paths: string[] = [];
    const environment = detectRuntimeEnvironment({
      platform: "linux",
      env: {},
      readOsRelease(path) {
        paths.push(path);
        return content;
      },
    });

    assert.equal(environment.distribution, expected);
    assert.deepEqual(paths, ["/etc/os-release"]);
  });
}

test("Linux 发行版文件缺失或不可读时保留未知值且不泄露读取错误", () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const paths: string[] = [];
    const environment = detectRuntimeEnvironment({
      platform: "linux",
      env: {},
      readOsRelease(path) {
        paths.push(path);
        throw Object.assign(new Error("FILE_ERROR_SECRET_SENTINEL"), { code });
      },
    });

    assert.equal(environment.distribution, null);
    assert.deepEqual(
      paths,
      code === "ENOENT" ? ["/etc/os-release", "/usr/lib/os-release"] : ["/etc/os-release"],
    );
  }
});

test("macOS 不读取 Linux 发行版文件，并保留所选 shell", () => {
  const environment = detectRuntimeEnvironment({
    platform: "darwin",
    kernelRelease: "25.0.0",
    env: { SHELL: "/bin/zsh" },
    readOsRelease() {
      assert.fail("macOS 不应读取 os-release");
    },
  });

  assert.deepEqual(environment, {
    operatingSystem: "macOS",
    kernelRelease: "25.0.0",
    distribution: null,
    executionShell: "/bin/zsh",
  });
});

test("shell 上下文与执行器一致，缺失或空白时使用 /bin/sh", () => {
  for (const [shell, expected] of [
    [undefined, "/bin/sh"],
    ["", "/bin/sh"],
    [" \t ", "/bin/sh"],
    ["sh", "sh"],
    ["bash", "bash"],
    ["zsh", "zsh"],
    ["/usr/local/bin/bash", "/usr/local/bin/bash"],
  ] as const) {
    const environment = detectRuntimeEnvironment({ platform: "darwin", env: { SHELL: shell } });
    assert.equal(environment.executionShell, expected);
  }
});

test("未支持的 shell 不妨碍生成提示词，也不泄露其原始值", () => {
  for (const shell of ["/usr/bin/fish", "/bin/bash -c SHELL_SECRET_SENTINEL"]) {
    const environment = detectRuntimeEnvironment({ platform: "darwin", env: { SHELL: shell } });
    assert.equal(environment.executionShell, null);
  }
});
