import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import React from "react";

import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { detectDangerousCommand } from "../../../src/safety/dangerous-command.js";
import { importWithoutColor } from "../../helpers/import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [{ Box, render, renderToString }, { ConfirmView, isDangerConfirmationInput }] =
    await Promise.all([import("ink"), import("../../../src/ui/ConfirmView.js")]);

  return { Box, render, renderToString, ConfirmView, isDangerConfirmationInput };
});

for (const confirmation of ["", "EXECUTE"]) {
  void test(
    `无法判定的命令只有准确输入 EXECUTE 才确认：${confirmation || "仅 Enter"}`,
    { timeout: 3000 },
    async (t) => {
      const { render, ConfirmView } = await uiModules;
      const command = "command rm -rf /";
      const danger = detectDangerousCommand(command);
      assert.equal(danger?.rule, "indeterminate-shell-command");
      const stdin = new FakeTty();
      const stdout = new FakeTty();
      let output = "";
      stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      let confirmed = 0;
      let cancelled = 0;
      let finish: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const instance = render(
        <ConfirmView
          candidate={candidate()}
          command={command}
          resolvedValues={new Map()}
          danger={danger}
          onConfirm={() => {
            confirmed += 1;
            finish();
          }}
          onCancel={() => {
            cancelled += 1;
            finish();
          }}
        />,
        {
          stdin: stdin as unknown as NodeJS.ReadStream,
          stdout: stdout as unknown as NodeJS.WriteStream,
          stderr: stdout as unknown as NodeJS.WriteStream,
          interactive: true,
          exitOnCtrlC: false,
          patchConsole: false,
        },
      );
      t.after(async () => {
        instance.unmount();
        await new Promise<void>((resolve) => setImmediate(resolve));
        stdin.destroy();
        stdout.destroy();
      });
      await instance.waitUntilRenderFlush();
      assert.ok(output.includes("EXECUTE+Enter"));
      assert.ok(stdin.rawModeEnabled);
      if (confirmation !== "") {
        stdin.write(confirmation);
        await new Promise<void>((resolve) => setImmediate(resolve));
        await instance.waitUntilRenderFlush();
      }
      stdin.write("\r");
      await finished;
      assert.equal(confirmed, confirmation === "EXECUTE" ? 1 : 0);
      assert.equal(cancelled, confirmation === "EXECUTE" ? 0 : 1);
    },
  );
}

class FakeTty extends PassThrough {
  public readonly isTTY = true;
  public readonly columns = 160;
  public readonly rows = 40;
  public rawModeEnabled = false;

  public setRawMode(enabled: boolean): this {
    this.rawModeEnabled = enabled;
    return this;
  }

  public ref(): this {
    return this;
  }
  public unref(): this {
    return this;
  }
}

function candidate(): CommandCandidateContract {
  return {
    title: "Find file",
    command: "find . -name {{filename}}",
    description: "Find a file by name",
    dangerous: false,
    dangerReason: "",
    placeholders: [{ name: "filename", description: "File name" }],
  };
}
