import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import React from "react";
import type { UsageApprovalRequest } from "../../../src/usage/types.js";
import { importWithoutColor } from "./import-without-color.js";
import { sessionHarness, waitFor } from "./session-test-helpers.js";
import { PASTE_START, PASTE_END } from "../../../src/ui/paste-framing.js";

const modules = importWithoutColor(async () => {
  const [{ render }, { UsageApprovalView }, { InteractiveSessionProvider }] = await Promise.all([
    import("ink"),
    import("../../../src/ui/UsageApprovalView.js"),
    import("../../../src/ui/InteractiveSessionProvider.js"),
  ]);
  return { render, UsageApprovalView, InteractiveSessionProvider };
});

for (const rows of [1, 2]) {
  void test(`${rows} 行编辑器保留长路径下的参数与光标，非法编辑有可查看的错误`, async (t) => {
    const view = await renderApproval(t, { rows, columns: 20 });
    let offset = view.text().length;
    await view.send("\t");
    assert.ok(view.text().slice(offset).includes("--help"), "长程序路径不能遮住参数和光标");
    await view.send("\u0015");
    await view.send("--help | forged");
    offset = view.text().length;
    await view.send("\r");
    assert.ok(view.text().slice(offset).includes("参数无效"), "小屏必须显示错误");
    assert.deepEqual(view.approved, []);
    await view.send("\t");
    await view.send("\u0015");
    await view.send("--help");
    await view.send("\r\r");
    assert.deepEqual(view.approved, [], "保存不能在同批输入中直接批准");
    await view.send("\r");
    assert.deepEqual(view.approved, [["--help"]]);
  });
}

void test("编辑器的左右移动、前向删除与退格保留完整字素", async (t) => {
  const view = await renderApproval(t);
  await view.send("\t");
  await view.send("\u0015");
  await view.send("a👩🏽‍💻e\u0301");
  await view.send("\u001b[D");
  await view.send("\u007f");
  await view.send("\u001b[D");
  await view.send("\u001b[3~");
  await view.send("\u0005");
  await view.send("z");
  await view.send("\r");
  await view.send("\r");
  assert.deepEqual(view.approved, [["e\u0301z"]]);
});

void test("在组合符前插入基字符后退格删除整个新字素", async (t) => {
  const view = await renderApproval(t);
  await view.send("\t");
  await view.send("\u0015");
  await view.send("\u0301");
  await view.send("\u0001");
  await view.send("e");
  await view.send("\u007f");
  await view.send("ok");
  await view.send("\r");
  await view.send("\r");
  assert.deepEqual(view.approved, [["ok"]]);
});

void test("编辑后的本地危险参数必须重新输入 EXECUTE", async (t) => {
  const view = await renderApproval(t, { executable: "/bin/rm" });
  await view.send("\t");
  await view.send("\u0015");
  await view.send("-rf /");
  await view.send("\r");
  await waitFor(() => view.text().includes("EXECUTE>"), "未重新计算危险参数");
  await view.send("\r");
  assert.deepEqual(view.approved, []);
  await view.send("EXECUTE\r");
  assert.deepEqual(view.approved, [["-rf", "/"]]);
});

void test("一行审批可逐行查看完整命令、目的、风险和输出发送说明，缩放不批准", async (t) => {
  const view = await renderApproval(t, {
    rows: 1,
    columns: 20,
    args: ["part-".repeat(15) + "ARGS_END"],
    purpose: "purpose-".repeat(4) + "PURPOSE_END",
  });
  for (let index = 0; index < 55; index++) await view.send("\u001b[B");
  const text = view.text().replaceAll("\n", "");
  assert.ok(text.includes("ARGS_END"));
  assert.ok(text.includes("PURPOSE_END"));
  assert.ok(text.includes("未发现已知风险"));
  assert.ok(text.includes("provider"));
  assert.deepEqual(view.approved, []);
  await view.resize(0);
  await view.send("\r\r");
  assert.deepEqual(view.approved, []);
  await view.resize(12);
  await view.send("\r");
  assert.deepEqual(view.approved, [["part-".repeat(15) + "ARGS_END"]]);
});

for (const [name, key] of [
  ["↑", "\u001b[A"],
  ["PageUp", "\u001b[5~"],
]) {
  void test(`一行危险审批输入后仍可用 ${name} 回看内容，缩放保留确认短语`, async (t) => {
    const view = await renderApproval(t, { rows: 1, columns: 80, executable: "/bin/rm" });
    await view.send("\t");
    await view.send("\u0015");
    await view.send("-rf /");
    await view.send("\r");
    await view.send("E");
    assert.ok(view.text().includes("EXECUTE> E"));
    const offset = view.text().length;
    for (let index = 0; index < 20; index++) await view.send(key);
    const reviewed = view.text().slice(offset);
    assert.ok(reviewed.includes("命令:"), "输入确认短语后无法回看命令");
    assert.ok(reviewed.includes("目的:"), "输入确认短语后无法回看目的");
    assert.ok(reviewed.includes("风险:"), "输入确认短语后无法回看风险");
    assert.deepEqual(view.approved, []);
    await view.resize(4);
    await view.resize(1);
    await view.send("XECUTE");
    assert.ok(view.text().includes("EXECUTE> EXECUTE"));
    await view.send("\r");
    assert.deepEqual(view.approved, [["-rf", "/"]]);
  });
}

void test("命令预览区分 CR 与 LF，凭据在全量显示和编辑光标处均脱敏", async (t) => {
  const secret = "FAKE-known-credential";
  const view = await renderApproval(t, {
    executable: "/usr/bin/tool",
    rows: 20,
    columns: 100,
    args: ["a\rb\nc", secret],
    purpose: `检查 ${secret}`,
    knownCredentials: [secret],
  });
  assert.ok(view.text().includes("a␍b␊c"));
  assert.equal(view.text().includes(secret), false);
  await view.send("\t");
  for (let index = 0; index < 8; index++) await view.send("\u001b[D");
  assert.equal(view.text().includes(secret), false);
  assert.ok(view.text().includes("*****"));
});

void test("参数详情页忽略编辑动作及粘贴，返回后保留原参数与光标", async (t) => {
  const view = await renderApproval(t);
  const notices: string[] = [];
  view.session.subscribeInputNotice((message) => notices.push(message));
  await view.send("\t");
  await view.send("\t");
  const offset = view.text().length;
  await view.send("forged\u007f\u0015\u001b[D\u001b[3~");
  await view.send(PASTE_START + "forged" + PASTE_END);
  assert.equal(view.text().slice(offset).includes("编辑查询参数"), false);
  assert.ok(notices.some((message) => message.includes("忽略粘贴")));
  await view.send("\r\r");
  assert.deepEqual(view.approved, []);
  await view.send("\r");
  await view.send("\r");
  assert.deepEqual(view.approved, [["--help"]]);
});

void test("编辑器先遮罩长凭据，重叠短凭据不能暴露后缀或光标片段", async (t) => {
  const secret = "FAKE-token'private-suffix";
  const argument = `prefix:${secret}:tail`;
  const view = await renderApproval(t, {
    rows: 20,
    columns: 100,
    args: [argument],
    knownCredentials: ["FAKE-token", secret],
  });
  await view.send("\t");
  for (let index = 0; index < secret.length; index++) await view.send("\u001b[D");
  assert.equal(view.text().includes("private-suffix"), false);
  await view.send("\r");
  await view.send("\r");
  assert.deepEqual(view.approved, [[argument]]);
});

async function renderApproval(
  t: TestContext,
  options: {
    rows?: number;
    columns?: number;
    executable?: string;
    args?: string[];
    purpose?: string;
    knownCredentials?: string[];
  } = {},
) {
  const { render, UsageApprovalView, InteractiveSessionProvider } = await modules;
  const columns = options.columns ?? 80;
  let rows = options.rows ?? 12;
  const h = sessionHarness(rows + 1, columns);
  const approved: string[][] = [];
  const request: UsageApprovalRequest = {
    commandName: options.executable === "/bin/rm" ? "rm" : "local-cli",
    executable: options.executable ?? "/some/very/long/fixed/program/location/local-cli",
    lookup: {
      args: options.args ?? ["--help"],
      purpose: options.purpose ?? "查看命令用法",
      dangerous: false,
      dangerReason: "",
    },
  };
  const element = () => (
    <InteractiveSessionProvider session={h.session}>
      <UsageApprovalView
        request={request}
        availableRows={rows}
        availableColumns={columns}
        knownCredentials={options.knownCredentials}
        onApprove={(args) => approved.push(args)}
        onReject={() => assert.fail("不应拒绝查询")}
        onCancel={() => assert.fail("不应取消任务")}
      />
    </InteractiveSessionProvider>
  );
  const instance = render(element(), {
    stdin: h.session.input,
    stdout: h.session.output,
    stderr: h.session.output,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  t.after(async () => {
    instance.unmount();
    await instance.waitUntilExit();
    h.close();
  });
  await instance.waitUntilRenderFlush();
  await waitFor(() => h.text().includes("查询审批"), "没有显示审批页");
  return {
    ...h,
    approved,
    async send(input: string) {
      await h.send(input);
      await instance.waitUntilRenderFlush();
    },
    async resize(nextRows: number) {
      rows = nextRows;
      h.output.resize(rows + 1);
      instance.rerender(element());
      await instance.waitUntilRenderFlush();
    },
  };
}
