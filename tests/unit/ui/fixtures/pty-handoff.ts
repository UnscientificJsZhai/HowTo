import assert from "node:assert/strict";
import { fstatSync } from "node:fs";
import { once } from "node:events";
import { createInteractiveSession } from "../../../../src/ui/interactive-session.js";
import { runInteractiveCommand } from "../../../../src/ui/run-interactive-command.js";
import { executeCommand } from "../../../../src/execute.js";

const original = process.stdin;
const initialRaw = process.argv[2] === "raw";
if (initialRaw) original.setRawMode(true);
const originalEncoding = original.readableEncoding;
const session = createInteractiveSession({ input: original, output: process.stdout });
const command =
  "test -t 0 || exit 31; printf 'REVIEW_%s\\n' CHILD_READY; IFS= read -r review_value; printf 'REVIEW_CHILD_%s:%s\\n' LINE \"$review_value\"";

try {
  const result = await runInteractiveCommand({
    session,
    provider: {
      generateCommands: () =>
        Promise.resolve({
          rawText: JSON.stringify({
            commands: [
              { title: "PTY 交接测试", description: "仅读取一行并打印", command, placeholders: [] },
            ],
          }),
        }),
    },
    request: {
      question: "测试交接",
      arguments: [],
      structuredOutput: true,
      outputContract: "",
      safetyConstraints: "",
      systemPrompt: "",
      userPrompt: "",
    },
    execute: (text) => {
      assert.equal(original.destroyed, false);
      assert.equal(original.isRaw, initialRaw);
      assert.equal(original.readableEncoding, originalEncoding);
      assert.equal(fstatSync(0).isCharacterDevice(), true);
      // 此回调中没有 await；实际执行器同步到达继承原始 stdio 的 spawn。
      return executeCommand(text);
    },
  });
  assert.equal(result, 0);
  process.stdout.write("REVIEW_EXIT:0\n");

  // 子命令已经退出，现在验证原 stdin 对象和 fd 0 仍可独立读取。
  original.setRawMode(false);
  const received = once(original, "data");
  process.stdout.write("ORIGINAL_READY\n");
  const [value] = (await received) as [Buffer];
  assert.equal(value.toString(), "parent-verified\n");
  original.pause();
  original.unref();
  process.stdout.write(
    `REVIEW_FINISHED:${JSON.stringify({ node: process.versions.node, uv: process.versions.uv, initialRaw })}\n`,
  );
} finally {
  session.dispose();
  if (original.isRaw) original.setRawMode(false);
}
