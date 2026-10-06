import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { parseCliArgs } from "../../../../src/cli.js";
import { toAppError } from "../../../../src/errors.js";
import { initializeConfig } from "../../../../src/init/index.js";
import { createInteractiveSession } from "../../../../src/ui/interactive-session.js";
import { runInteractiveCommand } from "../../../../src/ui/run-interactive-command.js";
import { testCandidate, testRequest } from "../../../unit/ui/session-test-helpers.js";

const phase = process.argv[2];
const original = process.stdin;
const initialRaw = phase === "raw-confirm";
if (initialRaw) original.setRawMode(true);
process.stdout.on("resize", () =>
  writeFileSync("size", `${process.stdout.rows}:${process.stdout.columns}`),
);
const originalEncoding = original.readableEncoding;
const session = createInteractiveSession({ input: original, output: process.stdout });
const checkOriginal = () => {
  assert.equal(original.destroyed, false);
  assert.equal(original.isRaw, initialRaw);
  assert.equal(original.readableEncoding, originalEncoding);
};

try {
  if (phase === "init") {
    await initializeConfig({
      cliOptions: parseCliArgs(["--init"]).options,
      env: process.env,
      session,
    });
    process.exitCode = 0;
  } else {
    process.exitCode = await runInteractiveCommand({
      session,
      provider: {
        generateCommands: (_request, signal) => {
          if (phase === "loading") {
            process.stdout.write("PROVIDER_PENDING\n");
            return new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("请求已中止")), {
                once: true,
              });
            });
          }
          return Promise.resolve({
            rawText: JSON.stringify({
              commands: [
                phase === "placeholder"
                  ? {
                      ...testCandidate("printf '%s' '{{value}}'"),
                      placeholders: [{ name: "value", description: "PLACEHOLDER_SENTINEL" }],
                    }
                  : testCandidate(),
              ],
            }),
          });
        },
      },
      request: testRequest(),
      execute: () => {
        checkOriginal();
        // 执行替身只写隔离目录标记，不启动命令；信号测试必须证明没有到达这里。
        writeFileSync("executed", "yes");
        process.stdout.write("COMMAND_EXECUTED\n");
        return Promise.resolve(0);
      },
      print: () => {
        checkOriginal();
        writeFileSync("printed", "yes");
        process.stdout.write("COMMAND_PRINTED\n");
      },
    });
  }
} catch (error) {
  process.exitCode = toAppError(error).exitCode;
} finally {
  session.dispose();
  checkOriginal();
}
process.stdout.write(`FIXTURE_EXIT:${process.exitCode}\n`);
