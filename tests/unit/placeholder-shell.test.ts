import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PlaceholderResolutionError,
  replaceCommandPlaceholders,
} from "../../src/ui/placeholder-logic.js";
import { resolveCommandDanger } from "../../src/safety/command-risk.js";

const executor = new URL("../../src/execute.js", import.meta.url).href;

test("replaceCommandPlaceholders 原样替换占位符并保留引用与多处引用", () => {
  const cases: [string, Map<string, string>, string][] = [
    ["printf {{value}}", new Map([["value", "alpha beta"]]), "printf alpha beta"],
    ["printf '{{value}}'", new Map([["value", "a'b"]]), "printf 'a'b'"],
    ['printf "{{value}}"', new Map([["value", 'a"b']]), 'printf "a"b"'],
    [
      "cmd {{a}} and {{b}}",
      new Map([
        ["a", "1"],
        ["b", "2"],
      ]),
      "cmd 1 and 2",
    ],
    ["cmd {{value}} {{value}}", new Map([["value", "dup"]]), "cmd dup dup"],
    ["cmd {{val}}", new Map([["val", "中👩‍💻"]]), "cmd 中👩‍💻"],
    ["cmd {{val}}", new Map([["val", "-flag"]]), "cmd -flag"],
  ];

  for (const [template, values, expected] of cases) {
    assert.equal(replaceCommandPlaceholders(template, values), expected);
  }

  assert.throws(
    () => replaceCommandPlaceholders("cmd {{unknown}}", new Map([["val", "1"]])),
    PlaceholderResolutionError,
  );
});

test("占位符替换后重新判断最终命令风险，不执行危险字符串", () => {
  const candidate = { dangerous: false, dangerReason: "" };
  const command = replaceCommandPlaceholders(
    "printf {{value}}",
    new Map([["value", "ok; rm -rf /"]]),
  );
  assert.ok(resolveCommandDanger(command, candidate));
  assert.equal(resolveCommandDanger("printf ok", candidate), undefined);
});

test("executeCommand 继承指定的自定义环境变量与当前工作目录", () => {
  const home = mkdtempSync(join(tmpdir(), "howto-env-test-"));
  try {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {executeCommand} from ${JSON.stringify(executor)}; process.exitCode = await executeCommand('printf "%s" "$HOWTO_CUSTOM_VAR"');`,
      ],
      {
        cwd: home,
        env: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/sh",
          HOWTO_CUSTOM_VAR: "custom_value",
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "custom_value");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
