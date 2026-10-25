import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import type { UsageSessionTurn } from "../../../../src/usage/types.js";

const phase = process.argv[2];
if (phase === "query-child") {
  // 此分支只使用 Node 内置模块，启动后立即握手；不读取终端或真实配置。
  process.on("SIGTERM", () => {});
  process.stdout.write("QUERY_PARTIAL_OUTPUT\n");
  writeFileSync("query-pid", String(process.pid));
  setInterval(() => {
    if (existsSync("query-release")) process.exit(0);
  }, 10);
} else {
  const [
    { toAppError },
    { createInteractiveSession },
    { runInteractiveCommand },
    { formatUsageCommand },
    { testCandidate, testRequest },
  ] = await Promise.all([
    import("../../../../src/errors.js"),
    import("../../../../src/ui/interactive-session.js"),
    import("../../../../src/ui/run-interactive-command.js"),
    import("../../../../src/usage/arguments.js"),
    import("../../../unit/ui/session-test-helpers.js"),
  ]);
  const original = process.stdin;
  const originalEncoding = original.readableEncoding;
  const session = createInteractiveSession({ input: original, output: process.stdout });
  const args = [import.meta.filename, "query-child"];
  const finalCommand = formatUsageCommand(process.execPath, [import.meta.filename, "final-child"]);
  let sessionCount = 0;
  let turns = 0;
  let executions = 0;
  let prints = 0;
  const checkOriginal = () => {
    assert.equal(original.destroyed, false);
    assert.equal(original.isRaw, false);
    assert.equal(original.readableEncoding, originalEncoding);
  };
  try {
    process.exitCode = await runInteractiveCommand({
      session,
      provider: {
        generateCommands: () => assert.fail("use 查询必须使用请求级会话"),
        createUsageSession: () => {
          sessionCount++;
          return {
            next: (replies, options): Promise<UsageSessionTurn> => {
              turns++;
              if (turns === 1) {
                assert.equal(options.toolsEnabled, true);
                return Promise.resolve<UsageSessionTurn>({
                  kind: "tool_calls",
                  calls: [
                    {
                      id: "pty-query",
                      name: "lookup_command_usage",
                      arguments: {
                        args,
                        purpose: "PTY_QUERY_PURPOSE",
                        dangerous: false,
                        dangerReason: "",
                      },
                    },
                  ],
                });
              }
              assert.equal(phase, "paste");
              assert.equal(options.toolsEnabled, true);
              assert.equal(replies.length, 1);
              assert.equal(replies[0].callId, "pty-query");
              assert.equal(replies[0].result.status, "success");
              assert.equal(replies[0].result.stdout, "QUERY_PARTIAL_OUTPUT\n");
              assert.deepEqual(replies[0].result.actualCommand?.args, args);
              writeFileSync("tool-result.json", JSON.stringify(replies[0].result));
              return Promise.resolve<UsageSessionTurn>({
                kind: "final",
                rawText: JSON.stringify({
                  commands: [testCandidate(finalCommand)],
                  failureReason: "",
                }),
              });
            },
          };
        },
      },
      request: { ...testRequest(), useCommand: process.execPath },
      execute: () => {
        checkOriginal();
        executions++;
        writeFileSync("executed", "yes");
        process.stdout.write("COMMAND_EXECUTED\n");
        return Promise.resolve(0);
      },
      print: (command) => {
        checkOriginal();
        prints++;
        assert.equal(command, finalCommand);
        writeFileSync("printed", command);
        process.stdout.write("COMMAND_PRINTED\n");
      },
    });
  } catch (error) {
    process.exitCode = toAppError(error).exitCode;
  } finally {
    session.dispose();
    checkOriginal();
  }
  assert.equal(sessionCount, 1);
  assert.equal(turns, phase === "paste" ? 2 : 1);
  assert.equal(executions, phase === "paste" ? 1 : 0);
  assert.equal(prints, 0);
  assert.equal(existsSync("query-pid"), phase !== "approval");
  process.stdout.write(`FIXTURE_EXIT:${process.exitCode}\n`);
}
