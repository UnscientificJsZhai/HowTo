import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { UsageSessionTurn, UsageToolReply } from "../../../src/usage/types.js";
import { formatUsageCommand } from "../../../src/usage/arguments.js";
import { InteractionCancelledError } from "../../../src/ui/tty.js";
import { UsageToolsUnsupportedError } from "../../../src/ai/errors.js";
import { USAGE_CAPABILITY_FALLBACK_NOTICE } from "../../../src/usage/generate.js";
import { PASTE_END, PASTE_START } from "../../../src/ui/paste-framing.js";
import { importWithoutColor } from "./import-without-color.js";
import { sessionHarness, testCandidate, testRequest, waitFor } from "./session-test-helpers.js";

const modules = importWithoutColor(() => import("../../../src/ui/run-interactive-command.js"));

void test("查询编辑后重新审批；同批 Tab/Enter 与保存/Enter 不得跨页启动程序", async (t) => {
  const flow = await startFlow(t, [lookup("first", ["--help"])]);
  await flow.approval();
  assert.equal(existsSync(flow.log), false);
  await flow.send("\t\r");
  await waitFor(() => flow.text().includes("编辑查询参数"), "没有进入参数编辑");
  assert.equal(flow.turns.length, 1);
  await flow.send("\u0015nested 'two words' --help");
  await flow.send("\r\r");
  await waitFor(
    () => flow.text().includes("nested 'two words' --help"),
    "编辑后命令没有显示",
  ).catch((error: Error) => {
    throw new Error(`${error.message}\n${flow.text()}`);
  });
  assert.equal(existsSync(flow.log), false, "保存后的多余 Enter 不得直接批准");
  assert.equal(flow.turns.length, 1, "切换编辑页不能重启生成请求");
  await flow.send("\r");
  await flow.selected();
  assert.deepEqual(flow.turns[1][0].result.actualCommand?.args, ["nested", "two words", "--help"]);
  assert.equal(flow.turns[1][0].result.stdout, JSON.stringify(["nested", "two words", "--help"]));
  assert.deepEqual(JSON.parse((await readFile(flow.log, "utf8")).trim()), [
    "nested",
    "two words",
    "--help",
  ]);
  await flow.finish();
  assert.equal(flow.sessions(), 1);
});

void test("拒绝只结束当前查询，重复拒绝不再审批，LLM 可改用另一查询", async (t) => {
  const flow = await startFlow(t, [
    lookup("first", ["--first"]),
    lookup("repeat", ["--first"]),
    lookup("second", ["nested", "--help"]),
  ]);
  await flow.approval();
  await flow.send("\u001b");
  await waitFor(
    () => flow.turns.length === 3 && flow.text().includes("nested --help"),
    "拒绝后没有进入不同查询",
  );
  assert.equal(existsSync(flow.log), false);
  assert.equal(flow.turns[1][0].result.status, "rejected");
  assert.equal(flow.turns[2][0].result.status, "rejected");
  await flow.send("\r");
  await flow.selected();
  assert.equal(flow.turns[3][0].result.status, "success");
  assert.equal((await readFile(flow.log, "utf8")).trim().split("\n").length, 1);
  await flow.finish();
});

for (const phase of ["approval", "editing", "running"] as const) {
  void test(`查询 ${phase} 阶段粘贴按页面处理，后续查询与最终执行继续可用`, async (t) => {
    const flow = await startFlow(t, [
      lookup("query", phase === "running" ? ["--wait"] : ["--help"]),
    ]);
    await flow.approval();
    if (phase === "editing") {
      await flow.send("\t");
      await waitFor(() => flow.text().includes("编辑查询参数"), "没有进入编辑页");
    } else if (phase === "running") {
      await flow.send("\r");
      await waitFor(() => existsSync(flow.log), "查询尚未运行");
    }
    if (phase === "editing") {
      await flow.send("\u0015");
      await flow.send(PASTE_START + "nested 'two words' --help" + PASTE_END + "\r\r");
      assert.equal(existsSync(flow.log), false);
      await flow.send("\r");
    } else {
      await flow.send(PASTE_START + "IGNORED\r" + PASTE_END);
      assert.equal(flow.turns.length, 1, "粘贴不能结束当前审批或运行查询");
      if (phase === "approval") await flow.send("\r");
      else await flow.releaseQuery();
    }
    await flow.selected();
    assert.equal(flow.session.getExecutionPolicy(), "execute");
    assert.equal(flow.turns[1][0].result.status, "success");
    if (phase === "editing")
      assert.deepEqual(flow.turns[1][0].result.actualCommand?.args, [
        "nested",
        "two words",
        "--help",
      ]);
    await flow.finish();
    assert.deepEqual(flow.executed, [flow.finalCommand]);
    assert.deepEqual(flow.printed, []);
  });
}

for (const nextStep of ["final", "query"] as const) {
  void test(`查询在分片粘贴之间结束时仍可进入后续 ${nextStep}，不提前取消或执行`, async (t) => {
    const flow = await startFlow(t, [
      lookup("first", ["--wait"]),
      ...(nextStep === "query" ? [lookup("second", ["--help"])] : []),
    ]);
    // 回归时任务可能先于页面等待失败；交给下面的页面及结果断言报告。
    void flow.result.catch(() => {});
    await flow.approval();
    await flow.send("\r");
    await waitFor(() => existsSync(flow.log), "查询尚未运行");
    await flow.send(PASTE_START + "IGNORED\rEXECUTE");
    await flow.releaseQuery();

    if (nextStep === "query") {
      await waitFor(() => flow.text().includes("查看 second 用法"), "未进入后续查询审批");
      assert.equal((await readFile(flow.log, "utf8")).trim().split("\n").length, 1);
    } else {
      await flow.selected();
    }
    assert.equal(flow.turns[1][0].result.status, "success");
    assert.deepEqual(flow.executed, []);
    await flow.send("\r" + PASTE_END);
    assert.equal(flow.session.getExecutionPolicy(), "execute");
    if (nextStep === "query") {
      await flow.send("\r");
      await flow.selected();
      assert.equal(flow.turns[2][0].result.status, "success");
    }
    await flow.finish();
    assert.deepEqual(flow.executed, [flow.finalCommand]);
    assert.deepEqual(flow.printed, []);
  });
}

for (const phase of ["approval", "editing", "running"] as const) {
  void test(`Ctrl+C 取消整个 ${phase} 查询任务`, async (t) => {
    const flow = await startFlow(t, [
      lookup("query", phase === "running" ? ["--hang"] : ["--help"]),
    ]);
    const cancelled = assert.rejects(flow.result, InteractionCancelledError);
    await flow.approval();
    if (phase === "editing") {
      await flow.send("\t");
      await waitFor(() => flow.text().includes("编辑查询参数"), "没有进入编辑页");
    } else if (phase === "running") {
      await flow.send("\r");
      await waitFor(() => existsSync(flow.log), "查询尚未运行");
    }
    await flow.send("\u0003");
    await cancelled;
    assert.equal(flow.sessions(), 1);
    assert.equal(flow.turns.length, 1);
    assert.deepEqual(flow.executed, []);
    assert.deepEqual(flow.printed, []);
  });
}

void test("非法编辑不会退出编辑页；清空修改并保存后仍须独立审批", async (t) => {
  const flow = await startFlow(t, [lookup("query", ["--help"])]);
  await flow.approval();
  await flow.send("\t");
  await waitFor(() => flow.text().includes("编辑查询参数"), "没有进入编辑页");
  await flow.send("\u0015");
  await flow.send("--help | touch forged");
  await flow.send("\r");
  await waitFor(() => flow.text().includes("参数无效"), "非法字面参数没有被拒绝");
  assert.equal(existsSync(flow.log), false);
  await flow.send("\u0015");
  await flow.send("'nested help' --help");
  await flow.send("\r");
  await waitFor(() => flow.text().includes("'nested help' --help"), "保存后没有返回审批");
  await flow.send("\r");
  await flow.selected();
  assert.deepEqual(flow.turns[1][0].result.actualCommand?.args, ["nested help", "--help"]);
  await flow.finish();
});

void test("危险查询必须键入 EXECUTE；普通 Enter 不批准", async (t) => {
  const flow = await startFlow(t, [
    {
      kind: "tool_calls",
      calls: [
        {
          id: "danger",
          name: "lookup_command_usage",
          arguments: {
            args: ["--help"],
            purpose: "危险确认测试",
            dangerous: true,
            dangerReason: "测试风险",
          },
        },
      ],
    },
  ]);
  await flow.approval();
  await waitFor(() => flow.text().includes("EXECUTE>"), "危险确认未显示");
  await flow.send("\r");
  assert.equal(existsSync(flow.log), false);
  await flow.send("EXECUTE\r");
  await flow.selected();
  await flow.finish();
});

void test("已知用法直接生成，不增加查询审批或启动本机程序", async (t) => {
  const flow = await startFlow(t, []);
  await flow.selected();
  assert.equal(flow.text().includes("查询审批"), false);
  assert.equal(existsSync(flow.log), false);
  assert.equal(flow.sessions(), 1);
  assert.equal(flow.turns.length, 1);
  await flow.finish();
});

void test("一行终端的能力降级仍完整输出固定提示，降级后继续生成", async (t) => {
  let stderr = "";
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array<ArrayBufferLike>) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  const flow = await startFlow(t, [new UsageToolsUnsupportedError("openai", "test-model")], {
    rows: 2,
    columns: 20,
  });
  await waitFor(() => flow.turns.length === 2, "降级后未继续请求");
  assert.equal(stderr, `${USAGE_CAPABILITY_FALLBACK_NOTICE}\n`);
  assert.deepEqual(flow.toolModes, [true, false]);
  assert.equal(existsSync(flow.log), false);
  flow.output.columns = 80;
  flow.output.resize(24);
  await flow.selected();
  await flow.finish();
});

void test("查询启动前拒绝未闭合粘贴，完整粘贴不撤权且保留终端租约", () => {
  const h = sessionHarness();
  try {
    assert.equal(h.session.getExecutionPolicy(), "execute");
    h.input.write(PASTE_START);
    assert.throws(() => h.session.checkExecutionPolicy(), /尚未结束/);
    h.input.write(PASTE_END);
    assert.equal(h.session.checkExecutionPolicy(), "execute");
    assert.equal(h.input.isRaw, true);
    assert.equal(h.session.getExecutionPolicy(), "execute");
  } finally {
    h.close();
  }
});

void test("会话令牌在审批、编辑光标和运行预览的终端原始输出中均不可见", async (t) => {
  const tokens = ["FAKE-access-token", "FAKE-refresh'private-suffix", "FAKE-id-token"];
  const apiKey = "FAKE-api-credential";
  const args = ["--wait", apiKey, ...tokens.map((token) => `token=${token}:end`)];
  const query = lookup("private-query", args);
  assert.equal(query.kind, "tool_calls");
  if (query.kind !== "tool_calls") return;
  query.calls[0].arguments = {
    args,
    purpose: `检查 ${tokens.join(" ")}`,
    dangerous: false,
    dangerReason: "",
  };
  const flow = await startFlow(t, [query], {
    rows: 24,
    columns: 160,
    knownCredentials: [apiKey],
    getSessionCredentials: () => tokens,
  });
  await flow.approval();
  await waitFor(() => flow.text().includes("[REDACTED]"), "审批未显示脱敏标记");
  await flow.send("\t");
  await waitFor(() => flow.text().includes("编辑查询参数"), "未进入参数编辑");
  for (let index = 0; index < 8; index++) await flow.send("\u001b[D");
  await flow.send("\r");
  await flow.send("\r");
  await waitFor(() => flow.text().includes("查询运行中"), "查询运行状态未显示");
  for (const secret of [apiKey, ...tokens, "private-suffix"]) {
    assert.equal(flow.bytes().includes(Buffer.from(secret)), false);
  }
  await flow.releaseQuery();
  await flow.selected();
  await flow.finish();
});

function lookup(id: string, args: string[]): UsageSessionTurn {
  return {
    kind: "tool_calls",
    calls: [
      {
        id,
        name: "lookup_command_usage",
        arguments: { args, purpose: `查看 ${id} 用法`, dangerous: false, dangerReason: "" },
      },
    ],
  };
}

async function startFlow(
  t: TestContext,
  steps: Array<UsageSessionTurn | Error>,
  dimensions: {
    rows?: number;
    columns?: number;
    knownCredentials?: readonly string[];
    getSessionCredentials?: () => readonly string[];
  } = {},
) {
  const { runInteractiveCommand } = await modules;
  const directory = await mkdtemp(join(tmpdir(), "howto-usage-ui-"));
  const executable = join(directory, "local-cli");
  const log = join(directory, "calls");
  await writeFile(
    executable,
    `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\nif (process.argv.includes('--hang')) setInterval(() => {}, 1000);\nif (process.argv.includes('--wait')) { const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(directory, "release"))})) clearInterval(timer); }, 10); }\n`,
    { mode: 0o700 },
  );
  const h = sessionHarness(dimensions.rows, dimensions.columns);
  const turns: UsageToolReply[][] = [];
  const toolModes: boolean[] = [];
  let sessions = 0;
  const finalCommand = formatUsageCommand(executable, ["final"]);
  const executed: string[] = [];
  const printed: string[] = [];
  const result = runInteractiveCommand({
    session: h.session,
    provider: {
      generateCommands: () => assert.fail("use 请求必须使用会话接口"),
      createUsageSession: () => {
        sessions++;
        return {
          getKnownCredentials: dimensions.getSessionCredentials,
          next: (replies, options) => {
            const index = turns.length;
            turns.push(replies);
            toolModes.push(options.toolsEnabled);
            if (steps[index] instanceof Error) return Promise.reject(steps[index]);
            return Promise.resolve(
              (steps[index] as UsageSessionTurn | undefined) ?? {
                kind: "final",
                rawText: JSON.stringify({
                  commands: [testCandidate(finalCommand)],
                  failureReason: "",
                }),
              },
            );
          },
        };
      },
    },
    request: { ...testRequest(), useCommand: executable },
    knownCredentials: dimensions.knownCredentials,
    execute: (command) => {
      executed.push(command);
      return Promise.resolve(0);
    },
    print: (command) => printed.push(command),
  });
  t.after(async () => {
    h.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    ...h,
    result,
    log,
    turns,
    toolModes,
    sessions: () => sessions,
    finalCommand,
    executed,
    printed,
    approval: () => waitFor(() => h.text().includes("查询审批"), "没有显示查询审批"),
    selected: () =>
      waitFor(() => h.text().includes("Select a command"), "没有生成最终候选").catch(
        (error: Error) => {
          throw new Error(`${error.message}\n${h.text()}\n${JSON.stringify(turns)}`);
        },
      ),
    releaseQuery: () => writeFile(join(directory, "release"), ""),
    async finish() {
      await h.send("\r");
      await waitFor(() => h.text().includes("Final command:"), "最终确认没有显示");
      await h.send("\r");
      assert.equal(await result, 0);
    },
  };
}
