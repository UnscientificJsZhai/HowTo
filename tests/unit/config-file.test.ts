import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigError } from "../../src/config.js";
import { getConfigFilePath } from "../../src/config-file.js";

test("getConfigFilePath accepts an absolute HOME and rejects a relative HOME", () => {
  const absoluteHome = join(tmpdir(), "howto-home-test-");

  assert.equal(
    getConfigFilePath({ HOME: absoluteHome }),
    join(absoluteHome, ".howto", "config.json"),
  );
  assert.throws(() => getConfigFilePath({ HOME: "relative-home" }), ConfigError);
});

test("HOME 缺失或为空白时只查询一次系统目录", () => {
  const systemHome = join(tmpdir(), "howto-system-home");
  for (const env of [{}, { HOME: "" }, { HOME: "   " }, { HOME: "\t" }]) {
    let queries = 0;
    assert.equal(
      getConfigFilePath(env, () => {
        queries += 1;
        return systemHome;
      }),
      join(systemHome, ".howto", "config.json"),
    );
    assert.equal(queries, 1);
  }
});

test("显式非空 HOME 保留原值且不调用系统查询", () => {
  const absoluteHome = `${join(tmpdir(), "howto-preserved-home")} `;
  const unexpectedLookup = () => {
    throw new Error("HOWTO_FAKE_UNEXPECTED_LOOKUP_SECRET");
  };
  assert.equal(
    getConfigFilePath({ HOME: absoluteHome }, unexpectedLookup),
    join(absoluteHome, ".howto", "config.json"),
  );
  assert.throws(
    () => getConfigFilePath({ HOME: " relative-home " }, unexpectedLookup),
    (error: unknown) =>
      error instanceof ConfigError && error.message === "config directory must be an absolute path",
  );
});

test("系统目录查询异常只返回固定配置错误", () => {
  assert.throws(
    () =>
      getConfigFilePath({ HOME: " " }, () => {
        throw new Error("\u001b[2JHOWTO_FAKE_HOME_LOOKUP_SECRET /private/fake-home");
      }),
    isSystemHomeError,
  );
});

for (const [label, value] of [
  ["empty", ""],
  ["spaces", "   "],
  ["tab", "\t"],
  ["relative", "relative-home"],
] as const) {
  test(`系统目录查询返回 ${label} 时固定失败`, () => {
    assert.throws(() => getConfigFilePath({}, () => value), isSystemHomeError);
  });
}

function isSystemHomeError(error: unknown): boolean {
  return error instanceof ConfigError && error.message === "failed to resolve user home directory";
}
