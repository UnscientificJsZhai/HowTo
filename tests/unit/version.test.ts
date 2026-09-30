import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const VERSION_MODULE = new URL("../../src/version.js", import.meta.url);

test("版本读取使用最近的包元数据，兼容源码、构建和测试目录", async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "howto-package-version-test-"));
  const version = "9.8.7-test.1";

  try {
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ type: "module", version }),
      "utf8",
    );

    for (const directory of ["src", "dist", "dist-test/src"]) {
      const modulePath = join(packageDirectory, directory, "version.js");
      await mkdir(dirname(modulePath), { recursive: true });
      await copyFile(VERSION_MODULE, modulePath);
      const { readPackageVersion } = (await import(pathToFileURL(modulePath).href)) as {
        readPackageVersion: () => string;
      };

      assert.equal(readPackageVersion(), version, directory);
    }
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});

test("最近的包元数据无效时返回错误，不回退到父级包版本", async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "howto-invalid-version-test-"));

  try {
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify({ type: "module", version: "9.8.7" }),
      "utf8",
    );
    const modulePath = join(packageDirectory, "dist", "version.js");
    await mkdir(dirname(modulePath));
    await copyFile(VERSION_MODULE, modulePath);
    const { readPackageVersion } = (await import(pathToFileURL(modulePath).href)) as {
      readPackageVersion: () => string;
    };

    for (const content of ["{", "null", "[]", "{}", '{"version":1}', '{"version":" "}']) {
      await writeFile(join(dirname(modulePath), "package.json"), content, "utf8");
      assert.throws(
        readPackageVersion,
        /package.json (?:is not valid JSON|must contain a version string)/,
      );
    }
  } finally {
    await rm(packageDirectory, { recursive: true, force: true });
  }
});

test("--version 不加载交互渲染依赖", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "howto-version-lazy-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const loader = `export async function resolve(specifier, context, next) { if (specifier === 'ink') throw new Error('version must not import Ink'); return next(specifier, context); }`;
  const registration = `import {register} from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)});`;
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(registration)}`,
      fileURLToPath(new URL("../../src/index.js", import.meta.url)),
      "--version",
    ],
    {
      env: { HOME: home, PATH: "/usr/bin:/bin", SHELL: "/bin/fish" },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^\d+\.\d+\.\d+\r?\n$/);
  assert.equal(child.stderr, "");
});
