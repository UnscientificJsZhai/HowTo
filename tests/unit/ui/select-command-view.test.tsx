import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { Box, renderToString } from "ink";
import { SelectCommandView } from "../../../src/ui/SelectCommandView.js";
import type { CommandCandidateContract } from "../../../src/ai/types.js";

void test("SelectCommandView renders a blank line between candidates", () => {
  const titleIndent = " ".repeat(2);
  const output = renderToString(
    <SelectCommandView
      candidates={[
        candidate("List directory contents", "ls -lh ./doc", "List files"),
        candidate("List files recursively", "find ./doc -maxdepth 1 -type f", "List direct files"),
        candidate("List hidden files", "ls -lah ./doc", "Include hidden files"),
      ]}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(output.includes(`List files\n\n${titleIndent}List files recursively`));
  assert.ok(output.includes(`List direct files\n\n${titleIndent}List hidden files`));
});

void test("SelectCommandView renders a blank line before footer help", () => {
  const output = renderToString(
    <SelectCommandView
      candidates={[candidate("List hidden files", "ls -lah ./doc", "Include hidden files")]}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(
    output.includes(
      "Include hidden files\n\nUse Up/Down to move, Enter to select, Esc or Ctrl+C to cancel.",
    ),
  );
});

void test("SelectCommandView keeps candidate spacing in a bounded frame", () => {
  const titleIndent = " ".repeat(2);
  const output = renderToString(
    <Box flexDirection="column" maxHeight={15} overflowY="hidden">
      <SelectCommandView
        candidates={[
          candidate("List directory contents", "ls -lh ./doc", "List files"),
          candidate(
            "List files recursively",
            "find ./doc -maxdepth 1 -type f",
            "List direct files",
          ),
          candidate("List hidden files", "ls -lah ./doc", "Include hidden files"),
        ]}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </Box>,
  );

  assert.ok(output.includes(`List direct files\n\n${titleIndent}List hidden files`));
});

function candidate(title: string, command: string, description: string): CommandCandidateContract {
  return {
    title,
    command,
    description,
    placeholders: [],
  };
}
