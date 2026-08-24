import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import {
  PlaceholderResolutionError,
  applyPlaceholderResolutionInput,
  createPlaceholderResolution,
  replaceCommandPlaceholders,
  resolveCandidatePlaceholders,
} from "../../../src/ui/placeholder-logic.js";

void test("createPlaceholderResolution initializes first placeholder state", () => {
  const state = createPlaceholderResolution(twoPlaceholderCandidate());

  assert.equal(state.activeIndex, 0);
  assert.deepEqual(state.values, ["", ""]);
  assert.equal(state.buffer, "");
  assert.equal(state.candidate.placeholders[0].name, "root");
});

void test("createPlaceholderResolution rejects candidates without placeholders", () => {
  assert.throws(
    () =>
      createPlaceholderResolution({
        title: "List files",
        command: "ls",
        description: "List current directory",
        placeholders: [],
      }),
    PlaceholderResolutionError,
  );
});

void test("applyPlaceholderResolutionInput appends, deletes, advances, and completes", () => {
  const candidate = twoPlaceholderCandidate();
  let state = createPlaceholderResolution(candidate);

  let transition = applyPlaceholderResolutionInput(state, { type: "append", value: "abc" });
  assert.equal(transition.type, "editing");
  assert.equal(transition.state.buffer, "abc");

  transition = applyPlaceholderResolutionInput(transition.state, { type: "delete" });
  assert.equal(transition.type, "editing");
  assert.equal(transition.state.buffer, "ab");

  transition = applyPlaceholderResolutionInput(transition.state, { type: "commit" });
  assert.equal(transition.type, "editing");
  assert.equal(transition.state.activeIndex, 1);
  assert.deepEqual(transition.state.values, ["ab", ""]);

  state = transition.state;
  transition = applyPlaceholderResolutionInput(state, {
    type: "append",
    value: ' raw value "with quotes" ',
  });
  assert.equal(transition.type, "editing");

  transition = applyPlaceholderResolutionInput(transition.state, { type: "commit" });
  assert.equal(transition.type, "complete");
  assert.equal(transition.resolved.command, 'find ab -name " raw value "with quotes" "');
  assert.deepEqual(Array.from(transition.resolved.values), [
    ["root", "ab"],
    ["filename", ' raw value "with quotes" '],
  ]);
});

void test("applyPlaceholderResolutionInput escapes to the previous placeholder", () => {
  const state = {
    ...createPlaceholderResolution(twoPlaceholderCandidate()),
    activeIndex: 1,
    values: ["first", "stale second"],
    buffer: "draft second",
  };

  const transition = applyPlaceholderResolutionInput(state, { type: "escape" });

  assert.equal(transition.type, "editing");
  assert.equal(transition.state.activeIndex, 0);
  assert.equal(transition.state.buffer, "first");
  assert.deepEqual(transition.state.values, ["first", ""]);
});

void test("applyPlaceholderResolutionInput escapes from first placeholder to selection", () => {
  const state = createPlaceholderResolution(twoPlaceholderCandidate());
  const transition = applyPlaceholderResolutionInput(state, { type: "escape" });

  assert.equal(transition.type, "back-to-selection");
});

void test("resolveCandidatePlaceholders replaces repeated placeholder references", () => {
  const candidate: CommandCandidateContract = {
    title: "Echo twice",
    command: "printf '%s %s' {{name}} {{name}}",
    description: "Print a value twice",
    placeholders: [{ name: "name", description: "Value to print" }],
  };

  const resolved = resolveCandidatePlaceholders(candidate, new Map([["name", "alpha beta"]]));

  assert.equal(resolved.command, "printf '%s %s' alpha beta alpha beta");
});

void test("replaceCommandPlaceholders parses only the original template once", () => {
  const template = "printf '%s %s' {{first}} {{second}}";
  const expected = "printf '%s %s' {{second}} done";

  for (const values of [
    new Map([
      ["first", "{{second}}"],
      ["second", "done"],
    ]),
    new Map([
      ["second", "done"],
      ["first", "{{second}}"],
    ]),
  ]) {
    assert.equal(replaceCommandPlaceholders(template, values), expected);
  }
});

void test("replaceCommandPlaceholders preserves placeholder-like user values literally", () => {
  for (const value of ["{{value}}", "{{unknown}}", "prefix {{second}} suffix"]) {
    assert.equal(
      replaceCommandPlaceholders("echo {{value}}", new Map([["value", value]])),
      `echo ${value}`,
    );
  }
});

void test("replaceCommandPlaceholders distinguishes an empty value from a missing value", () => {
  assert.equal(
    replaceCommandPlaceholders("before{{value}}after{{value}}", new Map([["value", ""]])),
    "beforeafter",
  );

  assert.throws(
    () => replaceCommandPlaceholders("echo {{missing}}", new Map()),
    (error: unknown) =>
      error instanceof PlaceholderResolutionError &&
      error.message === "final command contains unresolved placeholders",
  );
});

void test("resolveCandidatePlaceholders throws when placeholders remain unresolved", () => {
  const candidate: CommandCandidateContract = {
    title: "Echo missing",
    command: "echo {{known}} {{missing}}",
    description: "Print values",
    placeholders: [{ name: "known", description: "Known value" }],
  };

  assert.throws(
    () => resolveCandidatePlaceholders(candidate, new Map([["known", "ok"]])),
    (error: unknown) =>
      error instanceof PlaceholderResolutionError &&
      error.message === "final command contains unresolved placeholders",
  );
});

function twoPlaceholderCandidate(): CommandCandidateContract {
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
