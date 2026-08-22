import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [{ renderToString }, { ResolvePlaceholdersView }, { SelectedCommandDisplay }] =
    await Promise.all([
      import("ink"),
      import("../../../src/ui/ResolvePlaceholdersView.js"),
      import("../../../src/ui/SelectedCommandDisplay.js"),
    ]);

  return { renderToString, ResolvePlaceholdersView, SelectedCommandDisplay };
});

void test("ResolvePlaceholdersView renders the active placeholder prompt", async () => {
  const { renderToString, ResolvePlaceholdersView } = await uiModules;
  const output = renderToString(
    <ResolvePlaceholdersView
      candidate={candidate()}
      availableRows={10}
      availableColumns={120}
      onResolve={() => {}}
      onBack={() => {}}
      onCancel={() => {}}
    />,
  );

  assert.ok(output.includes("Find file"));
  assert.ok(output.includes('find {{root}} -name "{{filename}}"'));
  assert.ok(output.includes("root: Search root"));
  assert.ok(output.includes("? Fill command placeholders"));
  assert.ok(output.includes("Enter=next Esc=back"));
});

void test("ResolvePlaceholdersView keeps essential content within every row budget", async () => {
  const { renderToString, ResolvePlaceholdersView } = await uiModules;

  const renderBudget = (availableRows: number, availableColumns: number) =>
    stripVTControlCharacters(
      renderToString(
        <ResolvePlaceholdersView
          candidate={candidate()}
          availableRows={availableRows}
          availableColumns={availableColumns}
          onResolve={() => {}}
          onBack={() => {}}
          onCancel={() => {}}
        />,
        { columns: availableColumns },
      ),
    );

  for (const availableColumns of [20, 40]) {
    assert.equal(renderBudget(0, availableColumns), "");

    const outputs = new Map(
      [1, 2, 3, 4, 9, 10].map((availableRows) => [
        availableRows,
        renderBudget(availableRows, availableColumns),
      ]),
    );

    for (const [availableRows, output] of outputs) {
      assert.ok(output.split("\n").length <= availableRows);
    }

    const oneRow = outputs.get(1) ?? "";
    assert.equal(oneRow.split("\n").length, 1);
    assert.ok(oneRow.startsWith("root:"));
    assert.ok(oneRow.endsWith(" Ent Esc"));

    const twoRows = outputs.get(2) ?? "";
    assert.equal(twoRows.split("\n").length, 2);
    assert.ok(twoRows.startsWith("? root: Search root\n>"));
    assert.ok(twoRows.endsWith(" Ent Esc"));

    const threeRows = outputs.get(3) ?? "";
    assert.equal(threeRows.split("\n").length, 3);
    assert.ok(threeRows.startsWith("? root: Search root\n>"));
    assert.ok(threeRows.endsWith("Enter=next Esc=back"));

    assert.ok((outputs.get(4) ?? "").includes("? Fill command"));
    assert.ok(!(outputs.get(9) ?? "").includes("Find file"));
    assert.ok((outputs.get(10) ?? "").includes("Find file"));
  }
});

void test("ResolvePlaceholdersView renders field line breaks as visible markers", async () => {
  const { renderToString, ResolvePlaceholdersView } = await uiModules;
  const rawCandidate: CommandCandidateContract = {
    title: "Print\r\nvalues",
    command: "printf 'literal\r\npart' {{first}} && rm -rf /tmp/{{second}}",
    description: "Describe\ncandidate",
    placeholders: [
      { name: "first", description: "First\r\nvalue" },
      { name: "second", description: "Second\nvalue" },
    ],
  };
  const markerCandidate: CommandCandidateContract = {
    title: "Print␍␊values",
    command: "printf 'literal␍␊part' {{first}} && rm -rf /tmp/{{second}}",
    description: "Describe␊candidate",
    placeholders: [
      { name: "first", description: "First␍␊value" },
      { name: "second", description: "Second␊value" },
    ],
  };
  const renderCandidate = (candidate: CommandCandidateContract) =>
    stripVTControlCharacters(
      renderToString(
        <ResolvePlaceholdersView
          candidate={candidate}
          availableRows={10}
          availableColumns={120}
          onResolve={() => {}}
          onBack={() => {}}
          onCancel={() => {}}
        />,
        { columns: 120 },
      ),
    );
  const output = renderCandidate(rawCandidate);
  const markerOutput = renderCandidate(markerCandidate);

  assert.ok(output.includes("Print␍␊values"));
  assert.ok(output.includes("literal␍␊part"));
  assert.ok(output.includes("Describe␊candidate"));
  assert.ok(output.includes("first: First␍␊value"));
  assert.ok(output.includes("{{first}}"));
  assert.ok(output.includes("{{second}}"));
  assert.ok(!output.includes("\r"));
  assert.equal(output.split("\n").length, markerOutput.split("\n").length);
  assert.equal(output, markerOutput);
});

void test("SelectedCommandDisplay renders current buffer line breaks as visible markers", async () => {
  const { renderToString, SelectedCommandDisplay } = await uiModules;
  const selectedCandidate: CommandCandidateContract = {
    title: "Print value",
    command: "printf 'literal' {{first}}",
    description: "Print the provided value",
    placeholders: [{ name: "first", description: "First value" }],
  };
  const renderBuffer = (value: string) =>
    stripVTControlCharacters(
      renderToString(
        <SelectedCommandDisplay
          candidate={selectedCandidate}
          resolvedValues={new Map()}
          currentBuffer={{ name: "first", value }}
        />,
        { columns: 120 },
      ),
    );
  const output = renderBuffer("A\r\nB");
  const markerOutput = renderBuffer("A␍␊B");

  assert.ok(output.includes("printf 'literal' A␍␊B"));
  assert.ok(!output.includes("\r"));
  assert.equal(output.split("\n").length, markerOutput.split("\n").length);
  assert.equal(output, markerOutput);
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
