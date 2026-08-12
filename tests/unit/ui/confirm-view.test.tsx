import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [{ Box, renderToString }, { ConfirmView, isDangerConfirmationInput }] = await Promise.all([
    import("ink"),
    import("../../../src/ui/ConfirmView.js"),
  ]);

  return { Box, renderToString, ConfirmView, isDangerConfirmationInput };
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
  assert.ok(output.includes("Enter execute; Esc/Ctrl+C cancel."));
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

  assert.ok(output.includes("Risk: recursive forced removal [destructive-rm]"));
  assert.ok(output.includes("Final command: rm -rf /tmp/example"));
  assert.ok(output.includes("EXECUTE+Enter; Esc/Ctrl+C |>"));
});

void test("ConfirmView keeps safe confirmation visible with long content in a narrow frame", async () => {
  const { Box, renderToString, ConfirmView } = await uiModules;
  const output = renderToString(
    <Box flexDirection="column" height={4} overflowY="hidden">
      <ConfirmView
        candidate={longCandidate()}
        command={`find /a/very/long/path/${"nested/".repeat(8)} -name package.json -print`}
        resolvedValues={new Map()}
        availableColumns={40}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    </Box>,
    { columns: 40 },
  );

  assert.ok(output.includes("Final command:"));
  assert.ok(output.includes("Enter execute; Esc/Ctrl+C cancel."));
  assert.ok(!output.includes("Description that must not displace"));
  assert.ok(output.split("\n").length <= 4);
});

void test("ConfirmView keeps all dangerous confirmation rows visible in a narrow frame", async () => {
  const { Box, renderToString, ConfirmView } = await uiModules;
  const output = renderToString(
    <Box flexDirection="column" height={3} overflowY="hidden">
      <ConfirmView
        candidate={longCandidate()}
        command={`rm -rf /a/very/long/path/${"nested/".repeat(8)}important-target`}
        resolvedValues={new Map()}
        danger={{
          rule: "destructive-rm",
          reason: "recursive forced removal with a long risk explanation",
        }}
        availableColumns={40}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    </Box>,
    { columns: 40 },
  );

  assert.equal(output.split("\n").length, 3);
  assert.ok(output.includes("Risk:"));
  assert.ok(output.includes("[destructive-rm]"));
  assert.ok(output.includes("Final command:"));
  assert.ok(output.includes("EXECUTE+Enter; Esc/Ctrl+C |>"));
});

void test("ConfirmView renders command line breaks as visible markers without adding rows", async () => {
  const { Box, renderToString, ConfirmView } = await uiModules;
  const output = renderToString(
    <Box flexDirection="column" height={3} overflowY="hidden">
      <ConfirmView
        candidate={candidate()}
        command={"rm -rf /tmp/first\r\nrm -rf /tmp/second"}
        resolvedValues={new Map()}
        danger={{ rule: "destructive-rm", reason: "recursive\nforced removal" }}
        availableColumns={80}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    </Box>,
    { columns: 80 },
  );

  assert.equal(output.split("\n").length, 3);
  assert.ok(output.includes("Risk: recursive␊forced removal"));
  assert.ok(output.includes("Final command: rm -rf /tmp/first␍␊rm -rf /tmp/second"));
  assert.ok(output.includes("EXECUTE+Enter; Esc/Ctrl+C |>"));
});

void test("ConfirmView keeps safe command and controls visible from three to one rows", async () => {
  const { renderToString, ConfirmView } = await uiModules;

  for (const command of ["printf abcdefghijklmnopqrstuvwxyz", "打印你好世界然后退出"]) {
    const threeRows = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        availableRows={3}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    assert.equal(threeRows.split("\n").length, 2);
    assert.ok(threeRows.includes("Final"));
    assert.ok(threeRows.includes("Enter execute"));

    const twoRows = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        availableRows={2}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    const twoRowLines = twoRows.split("\n");
    assert.equal(twoRowLines.length, 2);
    assert.ok(twoRowLines[0]?.startsWith("Final: "));
    assert.equal(twoRowLines[1], "Enter=run Esc=cancel");
    assert.ok(!twoRows.includes("…"));

    const oneRow = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        availableRows={1}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    assert.equal(oneRow.split("\n").length, 1);
    assert.ok(oneRow.endsWith(" Enter Esc"));
    assert.ok(oneRow.startsWith(command.slice(0, 1)));
    assert.ok(!oneRow.includes("…"));

    const hidden = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        availableRows={0}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    assert.equal(hidden, "");
  }
});

void test("ConfirmView keeps dangerous command, input, and controls visible at every visible row", async () => {
  const { renderToString, ConfirmView } = await uiModules;

  for (const command of ["rm -rf /tmp/abcdefghijklmnopqrstuvwxyz", "删除危险目录然后退出"]) {
    const threeRows = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        danger={{ rule: "destructive-rm", reason: "recursive forced removal" }}
        availableRows={3}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    assert.equal(threeRows.split("\n").length, 3);
    assert.ok(threeRows.includes("Risk:"));
    assert.ok(threeRows.includes("Final"));

    const twoRows = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        danger={{ rule: "destructive-rm", reason: "recursive forced removal" }}
        availableRows={2}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    const twoRowLines = twoRows.split("\n");
    assert.equal(twoRowLines.length, 2);
    assert.ok(twoRowLines[0]?.startsWith("Danger: "));
    assert.ok(twoRowLines[1]?.startsWith("X=EXECUTE:"));
    assert.ok(twoRowLines[1]?.endsWith(" Ent Esc"));
    assert.ok(!twoRows.includes("…"));

    const oneRow = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        danger={{ rule: "destructive-rm", reason: "recursive forced removal" }}
        availableRows={1}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    assert.equal(oneRow.split("\n").length, 1);
    assert.ok(oneRow.startsWith(command.slice(0, 1)));
    assert.ok(oneRow.includes("!X:"));
    assert.ok(oneRow.endsWith(" Ent Esc"));
    assert.ok(!oneRow.includes("…"));

    const hidden = renderToString(
      <ConfirmView
        candidate={candidate()}
        command={command}
        resolvedValues={new Map()}
        danger={{ rule: "destructive-rm", reason: "recursive forced removal" }}
        availableRows={0}
        availableColumns={20}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );
    assert.equal(hidden, "");
  }
});

void test("ConfirmView keeps the default three-row API compatible", async () => {
  const { renderToString, ConfirmView } = await uiModules;
  const output = renderToString(
    <ConfirmView
      candidate={candidate()}
      command="rm -rf /tmp/example"
      resolvedValues={new Map()}
      danger={{ rule: "destructive-rm", reason: "recursive forced removal" }}
      onConfirm={() => {}}
      onCancel={() => {}}
    />,
    { columns: 80 },
  );

  assert.equal(output.split("\n").length, 3);
  assert.ok(output.includes("Risk: recursive forced removal [destructive-rm]"));
  assert.ok(output.includes("Final command: rm -rf /tmp/example"));
  assert.ok(output.includes("EXECUTE+Enter; Esc/Ctrl+C |>"));
});

void test("ConfirmView renders only the command after confirmation is done", async () => {
  const { renderToString, ConfirmView } = await uiModules;

  for (const availableRows of [1, 2, 3]) {
    const output = renderToString(
      <ConfirmView
        candidate={candidate()}
        command="rm -rf /tmp/example"
        resolvedValues={new Map()}
        danger={{ rule: "destructive-rm", reason: "recursive forced removal" }}
        availableRows={availableRows}
        availableColumns={20}
        isDone
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
      { columns: 20 },
    );

    assert.equal(output.split("\n").length, 1);
    assert.ok(output.startsWith("rm"));
    assert.ok(!output.includes("Risk:"));
    assert.ok(!output.includes("X="));
    assert.ok(!output.includes("Enter"));
    assert.ok(!output.includes("Esc"));
  }
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

function longCandidate(): CommandCandidateContract {
  return {
    title: "A title that must not displace the final command",
    command: "find . -name {{filename}}",
    description: "Description that must not displace the confirmation controls ".repeat(4),
    placeholders: [{ name: "filename", description: "File name" }],
  };
}
