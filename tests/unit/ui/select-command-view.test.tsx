import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [{ Box, renderToString }, { SelectCommandView }] = await Promise.all([
    import("ink"),
    import("../../../src/ui/SelectCommandView.js"),
  ]);

  return { Box, renderToString, SelectCommandView };
});

void test("SelectCommandView renders a blank line between candidates", async () => {
  const { renderToString, SelectCommandView } = await uiModules;
  const titleIndent = " ".repeat(2);
  const output = renderToString(
    <SelectCommandView
      candidates={[
        candidate("List directory contents", "ls -lh ./doc", "List files"),
        candidate("List files recursively", "find ./doc -maxdepth 1 -type f", "List direct files"),
        candidate("List hidden files", "ls -lah ./doc", "Include hidden files"),
      ]}
      availableRows={15}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(output.includes(`List files\n\n${titleIndent}List files recursively`));
  assert.ok(output.includes(`List direct files\n\n${titleIndent}List hidden files`));
});

void test("SelectCommandView renders a blank line before footer help", async () => {
  const { renderToString, SelectCommandView } = await uiModules;
  const output = renderToString(
    <SelectCommandView
      candidates={[candidate("List hidden files", "ls -lah ./doc", "Include hidden files")]}
      availableRows={5}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(
    output.includes("Include hidden files\nUp/Down move; Enter select; Esc/Ctrl+C cancel."),
  );
});

void test("SelectCommandView keeps candidate spacing in a bounded frame", async () => {
  const { Box, renderToString, SelectCommandView } = await uiModules;
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
        availableRows={15}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </Box>,
  );

  assert.ok(output.includes(`List direct files\n\n${titleIndent}List hidden files`));
});

void test("SelectCommandView keeps its natural height below a larger row limit", async () => {
  const { renderToString, SelectCommandView } = await uiModules;
  const output = renderToString(
    <SelectCommandView
      candidates={[candidate("List files", "ls -lah", "List directory contents")]}
      availableRows={23}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
    { columns: 80 },
  );

  assert.equal(output.split("\n").length, 5);
});

void test("SelectCommandView paginates and bounds long content in a four-row frame", async () => {
  const { Box, renderToString, SelectCommandView } = await uiModules;
  const output = renderToString(
    <Box flexDirection="column" height={4} overflowY="hidden">
      <SelectCommandView
        candidates={[
          candidate(
            "List files with a title that is much wider than the terminal",
            "find /a/very/long/path -name package.json -print",
            "Describe the command with text that must not displace the controls",
          ),
          candidate("Second command", "ls -lah /a/very/long/path", "Second description"),
          candidate("Third command", "pwd", "Third description"),
        ]}
        availableRows={4}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </Box>,
    { columns: 40 },
  );

  assert.equal(output.split("\n").length, 4);
  assert.ok(output.includes("? Select a command (1/3)"));
  assert.ok(output.includes("find"));
  assert.ok(output.includes("Up/Down move; Enter select"));
  assert.ok(!output.includes("Describe the command"));
  assert.ok(!output.includes("Second command"));
});

void test("SelectCommandView reserves one row each for header, command, and footer at narrow widths", async () => {
  const { Box, renderToString, SelectCommandView } = await uiModules;

  for (const columns of [20, 24]) {
    const output = stripVTControlCharacters(
      renderToString(
        <Box flexDirection="column" height={3} overflowY="hidden">
          <SelectCommandView
            candidates={[
              candidate(
                "First candidate title",
                "printf first-command",
                "First description must stay hidden",
              ),
              candidate("Second candidate", "printf second-command", "Second description"),
              candidate("Third candidate", "printf third-command", "Third description"),
            ]}
            availableRows={3}
            onSelect={() => {}}
            onCancel={() => {}}
          />
        </Box>,
        { columns },
      ),
    );
    const lines = output.split("\n");

    assert.equal(lines.length, 3, `expected exactly three rows at ${columns} columns`);
    assert.match(lines[0], /^\? Select \(1\/3\) Fir/);
    assert.match(lines[1], /^\s{4}printf/);
    assert.match(lines[2], /^↑↓; Enter; Esc\/\^C/);
    assert.ok(!output.includes("First description"));
    assert.ok(!output.includes("Second candidate"));
    assert.ok(!output.includes("printf second-command"));
    assert.ok(!output.includes("Third candidate"));
    assert.ok(!output.includes("printf third-command"));
  }
});

void test("SelectCommandView renders exact one-row and two-row layouts at twenty columns", async () => {
  const { renderToString, SelectCommandView } = await uiModules;
  const candidates = [
    candidate("First title", "pwd", "First description"),
    candidate("Second title", "date", "Second description"),
    candidate("Third title", "whoami", "Third description"),
  ];
  const renderRows = (availableRows: number) =>
    stripVTControlCharacters(
      renderToString(
        <SelectCommandView
          candidates={candidates}
          availableRows={availableRows}
          onSelect={() => {}}
          onCancel={() => {}}
        />,
        { columns: 20 },
      ),
    );

  assert.equal(renderRows(2), "? 1/3 pwd\n↑↓; Enter; Esc/^C");
  assert.equal(renderRows(1), "pwd 1/3 UD Enter Esc");
  assert.equal(renderRows(0), "");
});

void test("SelectCommandView keeps an ASCII command prefix without an ellipsis in one row", async () => {
  const { renderToString, SelectCommandView } = await uiModules;
  const output = stripVTControlCharacters(
    renderToString(
      <SelectCommandView
        candidates={[
          candidate("First title", "printf first-command", "First description"),
          candidate("Second title", "pwd", "Second description"),
          candidate("Third title", "date", "Third description"),
        ]}
        availableRows={1}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    ),
  );

  assert.equal(output, "pri 1/3 UD Enter Esc");
  assert.ok(!output.includes("…"));
});

void test("SelectCommandView keeps a CJK command prefix and ASCII controls in one row", async () => {
  const { renderToString, SelectCommandView } = await uiModules;
  const output = stripVTControlCharacters(
    renderToString(
      <SelectCommandView
        candidates={[
          candidate("First title", "删除临时目录", "First description"),
          candidate("Second title", "pwd", "Second description"),
          candidate("Third title", "date", "Third description"),
        ]}
        availableRows={1}
        onSelect={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    ),
  );

  assert.equal(output.split("\n").length, 1);
  assert.ok(output.startsWith("删"));
  assert.match(output, / 1\/3 UD Enter Esc$/);
  assert.ok(!output.includes("…"));
});

void test("SelectCommandView keeps command, page, and controls visible in one-row and two-row frames", async () => {
  const { renderToString, SelectCommandView } = await uiModules;
  const candidates = [
    candidate(
      "First candidate title",
      "printf first-command-with-a-long-suffix",
      "First description must stay hidden",
    ),
    candidate("Second candidate", "printf second-command", "Second description"),
    candidate("Third candidate", "printf third-command", "Third description"),
  ];

  for (const columns of [20, 40]) {
    for (const availableRows of [1, 2]) {
      const output = stripVTControlCharacters(
        renderToString(
          <SelectCommandView
            candidates={candidates}
            availableRows={availableRows}
            onSelect={() => {}}
            onCancel={() => {}}
          />,
          { columns },
        ),
      );
      const lines = output.split("\n");

      assert.equal(lines.length, availableRows);
      assert.ok(output.includes("1/3"));
      assert.match(lines[0], /p/);
      if (availableRows === 1) {
        assert.match(lines[0], / 1\/3 UD Enter Esc$/);
      } else {
        assert.match(lines[0], /^\? 1\/3 p/);
        assert.equal(lines[1], "↑↓; Enter; Esc/^C");
      }
      assert.ok(!output.includes("First candidate title"));
      assert.ok(!output.includes("First description"));
      assert.ok(!output.includes("printf second-command"));
      assert.ok(!output.includes("printf third-command"));
    }
  }
});

void test("SelectCommandView keeps multiline fields on one line in a three-row frame", async () => {
  const { Box, renderToString, SelectCommandView } = await uiModules;
  const output = renderToString(
    <Box flexDirection="column" height={3} overflowY="hidden">
      <SelectCommandView
        candidates={[
          candidate(
            "First title\nInjected title line",
            "printf first\r\nprintf second",
            "First description\nInjected description line",
          ),
          candidate("Second command", "pwd", "Second description"),
        ]}
        availableRows={3}
        onSelect={() => {}}
        onCancel={() => {}}
      />
    </Box>,
    { columns: 80 },
  );

  assert.equal(output.split("\n").length, 3);
  assert.ok(output.includes("First title␊Injected title line"));
  assert.ok(output.includes("printf first␍␊printf second"));
  assert.ok(output.includes("↑↓; Enter; Esc/^C"));
  assert.ok(!output.includes("Injected description line"));
});

function candidate(title: string, command: string, description: string): CommandCandidateContract {
  return {
    title,
    command,
    description,
    placeholders: [],
  };
}
