import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToString } from "ink";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { ResolvePlaceholdersView } from "../../../src/ui/ResolvePlaceholdersView.js";

void test("ResolvePlaceholdersView renders the active placeholder prompt", () => {
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
