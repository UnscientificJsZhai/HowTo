import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { releaseTagMatchesPackageVersion } from "../../scripts/validate-release-version.js";

const successMessage = "Release tag matches package version.\n";
const mismatchMessage = "release tag must match package version\n";
const readFailureMessage = "failed to read package version for release validation\n";
const releaseScript = fileURLToPath(
  new URL("../../../scripts/validate-release-version.ts", import.meta.url),
);

for (const releaseTag of ["1.0.1", "v1.0.1"]) {
  test(`纯校验接受完整匹配的标签 ${releaseTag}`, () => {
    assert.equal(releaseTagMatchesPackageVersion("1.0.1", releaseTag), true);
  });
}

test("真实发布 TS 入口接受完整匹配的标签 v1.0.1", async (t) => {
  const cwd = await createPackageDirectory(t, JSON.stringify({ version: "1.0.1" }));
  assertReleaseResult(cwd, "v1.0.1", 0, successMessage, "");
});

for (const [label, packageVersion, releaseTag] of [
  ["版本错配", "1.0.1", "v1.0.2"],
  ["大写前缀", "1.0.1", "V1.0.1"],
  ["重复前缀", "1.0.1", "vv1.0.1"],
  ["其他前缀", "1.0.1", "release/1.0.1"],
  ["前导空格", "1.0.1", " v1.0.1"],
  ["尾随空格", "1.0.1", "v1.0.1 "],
  ["尾随换行", "1.0.1", "1.0.1\n"],
  ["空标签", "1.0.1", ""],
  ["空包版本", "", "v"],
] as const) {
  test(`纯校验拒绝${label}`, () => {
    assert.equal(releaseTagMatchesPackageVersion(packageVersion, releaseTag), false);
  });
}

test("真实发布 TS 入口对版本错配返回固定摘要", async (t) => {
  const content = JSON.stringify({ version: "1.0.1" });
  const cwd = await createPackageDirectory(t, content);
  assertReleaseResult(cwd, "v1.0.2", 1, "", mismatchMessage);
});

test("真实发布 TS 入口对非对象 package.json 返回版本摘要", async (t) => {
  const cwd = await createPackageDirectory(t, '"1.0.1"');
  assertReleaseResult(cwd, "v1.0.1", 1, "", mismatchMessage);
});

test("真实发布 TS 入口对损坏 JSON 返回固定读取摘要", async (t) => {
  const cwd = await createPackageDirectory(t, '{"version":"HOWTO_FAKE_RELEASE_SECRET\\u001b');
  assertReleaseResult(cwd, "v1.0.1", 1, "", readFailureMessage);
});

test("真实发布 TS 入口对缺失 package.json 返回固定读取摘要", async (t) => {
  const cwd = await createPackageDirectory(t);
  assertReleaseResult(cwd, "v1.0.1", 1, "", readFailureMessage);
});

async function createPackageDirectory(t: test.TestContext, content?: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "howto-release-version-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (content !== undefined) {
    await writeFile(join(cwd, "package.json"), content, "utf8");
  }
  return cwd;
}

function assertReleaseResult(
  cwd: string,
  releaseTag: string | undefined,
  exitCode: number,
  stdout: string,
  stderr: string,
): void {
  const child = spawnSync(process.execPath, [releaseScript], {
    cwd,
    env: releaseTag === undefined ? {} : { RELEASE_TAG: releaseTag },
    shell: false,
    encoding: "utf8",
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null);
  assert.equal(child.status, exitCode);
  assert.equal(child.stdout, stdout);
  assert.equal(child.stderr, stderr);
}
