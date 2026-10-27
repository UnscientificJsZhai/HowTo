import assert from "node:assert/strict";
import { test } from "node:test";

import { PASTE_END, PASTE_START } from "../../../src/ui/paste-framing.js";
import {
  InteractiveSession,
  InteractiveSessionError,
} from "../../../src/ui/interactive-session.js";
import { SessionFakeTty } from "../../helpers/interactive-session.js";

void test("同批结束一块粘贴并开始下一块时，后一块取得完整总时限", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const input = new SessionFakeTty();
  const output = new SessionFakeTty();
  output.resume();
  const session = new InteractiveSession(
    input as unknown as NodeJS.ReadStream,
    output as unknown as NodeJS.WriteStream,
    {
      pasteIdleTimeoutMs: 500,
      pasteDurationLimitMs: 100,
    },
  );
  t.after(() => {
    session.dispose();
    input.destroy();
    output.destroy();
  });
  session.beginView();
  const failures: Error[] = [];
  session.subscribeFailure((error) => {
    failures.push(error);
  });
  input.write(PASTE_START + "first");
  assert.throws(() => session.checkExecutionPolicy(), /尚未结束/);
  t.mock.timers.tick(60);
  input.write(PASTE_END + PASTE_START + "second");
  assert.throws(() => session.checkExecutionPolicy(), /尚未结束/);
  t.mock.timers.tick(60);
  assert.equal(failures.length, 0, "后一块不能继承前一块的剩余时限");
  t.mock.timers.tick(40);
  assert.ok(failures[0] instanceof InteractiveSessionError);
});
