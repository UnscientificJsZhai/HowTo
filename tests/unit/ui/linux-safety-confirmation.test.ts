import assert from "node:assert/strict";
import test from "node:test";
import { InteractionCancelledError } from "../../../src/ui/tty.js";
import { importWithoutColor } from "./import-without-color.js";
import { sessionHarness, testCandidate, testRequest, waitFor } from "./session-test-helpers.js";

const modules = importWithoutColor(() => import("../../../src/ui/run-interactive-command.js"));

for (const command of ["busybox rm -rf /"]) {
  verifyDangerConfirmation(command);
}

function verifyDangerConfirmation(command: string): void {
  for (const confirmed of [false, true]) {
    void test(`Linux 危险命令 ${JSON.stringify(command)}：${confirmed ? "正确短语只交付一次原文" : "仅 Enter 不执行"}`, async (t) => {
      const { runInteractiveCommand } = await modules;
      const h = sessionHarness(24, 120);
      t.after(() => h.close());
      const executions: string[] = [];
      const printed: string[] = [];
      let completed = false;
      const completion = runInteractiveCommand({
        session: h.session,
        provider: {
          generateCommands: () =>
            Promise.resolve({
              rawText: JSON.stringify({ commands: [testCandidate(command)] }),
            }),
        },
        request: testRequest(),
        // 危险字符串仅交付替身；测试不启动任何子命令。
        execute: (text) => {
          executions.push(text);
          return Promise.resolve(7);
        },
        print: (text) => printed.push(text),
      }).then(
        (exitCode) => {
          completed = true;
          return exitCode;
        },
        (error: unknown) => {
          completed = true;
          return error;
        },
      );

      await waitFor(() => h.text().includes("Select a command"), "候选没有显示");
      await h.send("\r");
      await waitFor(() => h.text().includes("Final command:"), "最终确认没有显示");
      assert.ok(h.text().includes("EXECUTE+Enter"), "必须显示额外确认提示");
      assert.equal(h.session.getExecutionPolicy(), "execute");
      await h.send(confirmed ? "EXECUTE\r" : "\r");
      await waitFor(() => completed, "确认流程未完成");
      const result = await completion;
      if (confirmed) assert.equal(result, 7);
      else assert.ok(result instanceof InteractionCancelledError);
      assert.deepEqual(executions, confirmed ? [command] : []);
      assert.deepEqual(printed, []);
    });
  }
}
