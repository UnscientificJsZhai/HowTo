import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [{ renderToString }, { ResolvePlaceholdersView }] = await Promise.all([
    import("ink"),
    import("../../../src/ui/ResolvePlaceholdersView.js"),
  ]);

  return { renderToString, ResolvePlaceholdersView };
});

void test("ResolvePlaceholdersView renders the active placeholder prompt", async () => {
  const { renderToString, ResolvePlaceholdersView } = await uiModules;
  const output = renderToString(
    <ResolvePlaceholdersView
      candidate={candidate()}
      onResolve={() => {}}
      onBack={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(output.includes("Find file"));
  assert.ok(output.includes('find {{root}} -name "{{filename}}"'));
  assert.ok(output.includes("root: Search root"));
  assert.ok(output.includes("? Fill command placeholders"));
  assert.ok(output.includes("Press Enter for next value, Esc to go back, Ctrl+C to cancel."));
});

function candidate(): CommandCandidateContract {
  return {
    title: "Find file",
    command: 'find {{root}} -name "{{filename}}"',
    description: "Find a file by name",
    placeholders: [
      { name: "root", description: "Search root" },
      { name: "filename", description: "File name" },
    ],
  };
}
