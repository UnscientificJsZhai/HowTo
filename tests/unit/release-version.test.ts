import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

for (const packageVersion of ["1.0.1", "1.0.1-alpha.1", "1.0.1+build.7", "1.0.1-alpha.1+build.7"]) {
  for (const prefix of ["", "v"]) {
    const releaseTag = `${prefix}${packageVersion}`;
    test(`纯校验接受完整匹配的标签 ${releaseTag}`, () => {
      assert.equal(releaseTagMatchesPackageVersion(packageVersion, releaseTag), true);
    });
    test(`真实发布 TS 入口接受完整匹配的标签 ${releaseTag}`, async (t) => {
      const cwd = await createPackageDirectory(t, JSON.stringify({ version: packageVersion }));
      assertReleaseResult(cwd, releaseTag, 0, successMessage, "");
      assert.deepEqual(await readdir(cwd), ["package.json"]);
      assert.equal(
        await readFile(join(cwd, "package.json"), "utf8"),
        JSON.stringify({ version: packageVersion }),
      );
    });
  }
}

for (const [label, packageVersion, releaseTag] of [
  ["版本错配", "1.0.1", "v1.0.2"],
  ["大写前缀", "1.0.1", "V1.0.1"],
  ["重复前缀", "1.0.1", "vv1.0.1"],
  ["其他前缀", "1.0.1", "release/1.0.1"],
  ["前导空格", "1.0.1", " v1.0.1"],
  ["尾随空格", "1.0.1", "v1.0.1 "],
  ["尾随换行", "1.0.1", "1.0.1\n"],
  ["缺失预发布后缀", "1.0.1-alpha.1", "v1.0.1"],
  ["预发布后缀错配", "1.0.1-alpha.1", "v1.0.1-alpha.2"],
  ["额外预发布后缀", "1.0.1", "v1.0.1-alpha.1"],
  ["缺失构建元数据", "1.0.1+build.7", "v1.0.1"],
  ["构建元数据错配", "1.0.1+build.7", "v1.0.1+build.8"],
  ["空标签", "1.0.1", ""],
  ["缺失标签", "1.0.1", undefined],
  ["缺失包版本", undefined, "v1.0.1"],
  ["空包版本", "", "v"],
  ["null 包版本", null, "v1.0.1"],
  ["数字包版本", 101, "101"],
  ["对象包版本", {}, "v1.0.1"],
  ["数组包版本", ["1.0.1"], "v1.0.1"],
] as const) {
  test(`纯校验拒绝${label}`, () => {
    assert.equal(releaseTagMatchesPackageVersion(packageVersion, releaseTag), false);
  });
  test(`真实发布 TS 入口对${label}返回固定摘要`, async (t) => {
    const content = JSON.stringify({ version: packageVersion });
    const cwd = await createPackageDirectory(t, content);
    assertReleaseResult(cwd, releaseTag, 1, "", mismatchMessage);
    assert.deepEqual(await readdir(cwd), ["package.json"]);
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), content);
  });
}

for (const releaseTag of [null, 101, {}, ["1.0.1"], true]) {
  test(`纯校验拒绝非字符串标签 ${JSON.stringify(releaseTag)}`, () => {
    assert.equal(releaseTagMatchesPackageVersion("1.0.1", releaseTag), false);
  });
}

for (const [label, content] of [
  ["null 顶层", "null"],
  ["数组顶层", "[]"],
  ["字符串顶层", '"1.0.1"'],
  ["数字顶层", "101"],
]) {
  test(`真实发布 TS 入口对${label}返回版本摘要`, async (t) => {
    const cwd = await createPackageDirectory(t, content);
    assertReleaseResult(cwd, "v1.0.1", 1, "", mismatchMessage);
  });
}

test("真实发布 TS 入口对损坏 JSON 返回固定读取摘要", async (t) => {
  const cwd = await createPackageDirectory(t, '{"version":"HOWTO_FAKE_RELEASE_SECRET\u001b');
  assertReleaseResult(cwd, "v1.0.1", 1, "", readFailureMessage);
});

test("真实发布 TS 入口对缺失 package.json 返回固定读取摘要", async (t) => {
  const cwd = await createPackageDirectory(t);
  assertReleaseResult(cwd, "v1.0.1", 1, "", readFailureMessage);
  assert.deepEqual(await readdir(cwd), []);
});

test("真实发布 TS 入口对不可读取的 package.json 返回固定读取摘要", async (t) => {
  const cwd = await createPackageDirectory(t);
  await mkdir(join(cwd, "package.json"));
  assertReleaseResult(cwd, "v1.0.1", 1, "", readFailureMessage);
  assert.deepEqual(await readdir(join(cwd, "package.json")), []);
});

for (const [label, releaseTag] of [
  ["引号和命令分隔符", "1.0.1'\"; touch HOWTO_RELEASE_SENTINEL; #"],
  ["反引号", "`touch HOWTO_RELEASE_SENTINEL`"],
  ["命令替换", "$(touch HOWTO_RELEASE_SENTINEL)"],
  ["换行", "1.0.1\ntouch HOWTO_RELEASE_SENTINEL"],
  ["终端控制字符", "\u001b[2JHOWTO_FAKE_RELEASE_SECRET"],
]) {
  test(`真实发布 TS 入口不执行或回显含${label}的字面标签`, async (t) => {
    const cwd = await createPackageDirectory(t, '{"version":"1.0.1"}');
    assertReleaseResult(cwd, releaseTag, 1, "", mismatchMessage);
    assert.deepEqual(await readdir(cwd), ["package.json"]);
    assert.equal(await readFile(join(cwd, "package.json"), "utf8"), '{"version":"1.0.1"}');
  });
}

test("真实发布 TS 入口不回显包版本中的控制字符或假秘密", async (t) => {
  const cwd = await createPackageDirectory(
    t,
    JSON.stringify({ version: "\u001b[2JHOWTO_FAKE_RELEASE_SECRET" }),
  );
  assertReleaseResult(cwd, "v1.0.1", 1, "", mismatchMessage);
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

test("发布版本校验在解析 Release commit 前通过环境变量接收标签", async () => {
  const workflow = await readFile(
    new URL("../../../.github/workflows/publish.yml", import.meta.url),
    "utf8",
  );
  const setupPosition = workflow.indexOf("      - name: Setup Node.js\n");
  const validationPosition = workflow.indexOf("      - name: Validate release version\n");
  const resolvePosition = workflow.indexOf("      - name: Resolve release commit\n");

  assert.ok(setupPosition >= 0);
  assert.ok(validationPosition > setupPosition && validationPosition < resolvePosition);
  assert.equal(
    workflow.slice(validationPosition, resolvePosition),
    [
      "      - name: Validate release version",
      "        env:",
      "          RELEASE_TAG: ${{ github.event.release.tag_name }}",
      "        run: node scripts/validate-release-version.ts",
      "",
      "",
    ].join("\n"),
  );
});
