import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkCommandInPath } from "../../src/validation/command-tool.js";

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

test("未设置 PATH 时不搜索当前目录，但仍检查显式路径", (t) => {
  const root = mkdtempSync(join(tmpdir(), "howto-path-unset-"));
  const previousCwd = process.cwd();
  t.after(() => {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  const name = "local-tool";
  const absolutePath = join(root, name);
  writeFileSync(absolutePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  for (const env of [{}, { PATH: undefined }]) {
    assert.deepEqual(checkCommandInPath(name, env), { command: name, found: false });
    assert.equal(checkCommandInPath(`./${name}`, env).found, true);
    assert.equal(checkCommandInPath(absolutePath, env).resolvedPath, absolutePath);
  }
});
