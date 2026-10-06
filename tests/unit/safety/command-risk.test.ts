import assert from "node:assert/strict";
import test from "node:test";
import { resolveCommandDanger } from "../../../src/safety/command-risk.js";
import { detectDangerousCommand } from "../../../src/safety/dangerous-command.js";

const unflagged = { dangerous: false, dangerReason: "" };
const flagged = { dangerous: true, dangerReason: "会丢弃未提交的修改" };

test("两种检查均未标记时保留普通确认", () => {
  assert.equal(resolveCommandDanger("git status", unflagged), undefined);
});

test("AI 标记补充静态规则未覆盖的命令", () => {
  const command = "git reset --hard";
  assert.equal(detectDangerousCommand(command), undefined);
  assert.deepEqual(resolveCommandDanger(command, flagged), {
    rule: "ai-flagged-dangerous-command",
    reason: `AI: ${flagged.dangerReason}`,
  });
});

for (const command of ["rm -rf /", "busybox ls"]) {
  test(`AI 未标记不能降低静态危险或无法判定：${command}`, () => {
    const local = detectDangerousCommand(command);
    assert.ok(local);
    assert.deepEqual(resolveCommandDanger(command, unflagged), local);
  });

  test(`两者命中时保留静态规则并追加 AI 原因，不污染后续检查：${command}`, () => {
    const local = detectDangerousCommand(command);
    assert.ok(local);
    const original = { ...local };
    assert.deepEqual(resolveCommandDanger(command, flagged), {
      rule: original.rule,
      reason: `${original.reason}; AI: ${flagged.dangerReason}`,
    });
  });
}
