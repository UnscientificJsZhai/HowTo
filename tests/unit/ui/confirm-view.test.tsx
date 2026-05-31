import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [{ renderToString }, { ConfirmView, isDangerConfirmationInput }] = await Promise.all([
    import("ink"),
    import("../../../src/ui/ConfirmView.js"),
  ]);

  return { renderToString, ConfirmView, isDangerConfirmationInput };
});

void test("ConfirmView renders the final command on the safe path", async () => {
  const { renderToString, ConfirmView } = await uiModules;
  const output = renderToString(
    <ConfirmView
      candidate={candidate()}
      command="find . -name package.json"
      resolvedValues={new Map([["filename", "package.json"]])}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(output.includes("Final command: find . -name package.json"));
  assert.ok(output.includes("Press Enter to execute"));
});

void test("ConfirmView renders the final command on the dangerous path", async () => {
  const { renderToString, ConfirmView } = await uiModules;
  const output = renderToString(
    <ConfirmView
      candidate={candidate()}
      command="rm -rf /tmp/example"
      resolvedValues={new Map([["filename", "/tmp/example"]])}
      danger={{ rule: "destructive-rm", reason: "recursive forced removal" }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(output.includes("Dangerous command detected."));
  assert.ok(output.includes("Final command: rm -rf /tmp/example"));
  assert.ok(output.includes("Type EXECUTE to continue"));
});

void test("isDangerConfirmationInput accepts EXECUTE case-insensitively", async () => {
  const { isDangerConfirmationInput } = await uiModules;
  assert.equal(isDangerConfirmationInput("EXECUTE"), true);
  assert.equal(isDangerConfirmationInput("execute"), true);
  assert.equal(isDangerConfirmationInput("ExEcUtE"), true);
});

void test("isDangerConfirmationInput rejects non-matching input", async () => {
  const { isDangerConfirmationInput } = await uiModules;
  assert.equal(isDangerConfirmationInput("EXECUTE!"), false);
  assert.equal(isDangerConfirmationInput("run"), false);
  assert.equal(isDangerConfirmationInput(" execute "), false);
});

function candidate(): CommandCandidateContract {
  return {
    title: "Find file",
    command: "find . -name {{filename}}",
    description: "Find a file by name",
    placeholders: [{ name: "filename", description: "File name" }],
  };
}
