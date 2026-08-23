import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { AiProviderError } from "../../../src/ai/errors.js";
import { toAppError } from "../../../src/errors.js";
import { InteractionCancelledError } from "../../../src/ui/tty.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [
    { render },
    { App },
    { SelectCommandView },
    { ResolvePlaceholdersView },
    { ConfirmView },
    { toResizeSafeOutput },
  ] = await Promise.all([
    import("ink"),
    import("../../../src/ui/App.js"),
    import("../../../src/ui/SelectCommandView.js"),
    import("../../../src/ui/ResolvePlaceholdersView.js"),
    import("../../../src/ui/ConfirmView.js"),
    import("../../../src/ui/resize-safe-output.js"),
  ]);

  return {
    render,
    App,
    SelectCommandView,
    ResolvePlaceholdersView,
    ConfirmView,
    toResizeSafeOutput,
  };
});

void test("ResolvePlaceholdersView retains typed uppercase input before resolving", async (t) => {
  let resolvedCommand: string | undefined;
  const { ResolvePlaceholdersView } = await uiModules;
  const view = await renderView(
    <ResolvePlaceholdersView
      candidate={placeholderCandidate()}
      availableRows={10}
      availableColumns={120}
      onResolve={(resolved) => {
        resolvedCommand = resolved.command;
      }}
      onBack={() => {}}
      onCancel={() => {}}
    />,
  );
  t.after(() => close(view));

  assert.match(view.output(), /Fill command placeholders/);

  for (const character of "AbC") {
    await send(view, character);
  }
  await send(view, "\r");

  assert.equal(resolvedCommand, "printf '%s' AbC");
});

void test("ResolvePlaceholdersView preserves bracketed paste text verbatim", async (t) => {
  let resolvedCommand: string | undefined;
  const { ResolvePlaceholdersView } = await uiModules;
  const view = await renderView(
    <ResolvePlaceholdersView
      candidate={placeholderCandidate()}
      availableRows={10}
      availableColumns={120}
      onResolve={(resolved) => {
        resolvedCommand = resolved.command;
      }}
      onBack={() => {}}
      onCancel={() => {}}
    />,
  );
  t.after(() => close(view));

  const pastedValue = "My Path A! #";
  await send(view, `\u001B[200~${pastedValue}\u001B[201~`);
  await send(view, "\r");

  assert.equal(resolvedCommand, `printf '%s' ${pastedValue}`);
});

void test("App keeps placeholder input operable in two-, three-, and four-row terminals", async () => {
  const { App } = await uiModules;

  for (const scenario of [
    {
      rows: 2,
      selectionText: "1/1 UD Enter Esc",
      helpText: " Ent Esc",
      confirmationText: " Enter Esc",
    },
    {
      rows: 3,
      selectionText: "↑↓; Enter; Esc/^C",
      helpText: " Ent Esc",
      confirmationText: "Esc=cancel",
    },
    {
      rows: 4,
      selectionText: "? Select (1/1)",
      helpText: "Enter=next Esc=back",
      confirmationText: "Enter execute",
    },
  ]) {
    let finalCommand: string | undefined;
    let errorCount = 0;
    let unmounted = false;
    const view = await renderView(
      <App
        provider={{
          generateCommands: () =>
            Promise.resolve({ rawText: JSON.stringify({ commands: [placeholderCandidate()] }) }),
        }}
        request={appRequest()}
        onSuccess={(command) => {
          finalCommand = command;
        }}
        onError={() => {
          errorCount++;
        }}
      />,
      { columns: 20, rows: scenario.rows },
    );

    try {
      await waitForOutput(view, scenario.selectionText);
      await send(view, "\r");
      await waitForOutput(view, "value:");
      await waitForOutput(view, scenario.helpText);

      const inputOffset = view.output().length;
      await send(view, "Z");
      await waitForOutputAfter(view, inputOffset, "Z");
      await send(view, "\r");

      await waitForOutput(view, scenario.confirmationText);
      await send(view, "\r");
      await waitFor(() => finalCommand !== undefined, "App did not execute a compact input");

      assert.equal(finalCommand, "printf '%s' Z");
      assert.equal(errorCount, 0);
      await clearAndUnmount(view);
      unmounted = true;
      assertTerminalCleanup(view);
    } finally {
      if (!unmounted) {
        await close(view);
      }
    }
  }
});

void test("App renders placeholder line breaks safely while preserving the final command", async (t) => {
  const { App } = await uiModules;
  const generatedCandidate: CommandCandidateContract = {
    title: "Remove\r\ntemporary path",
    command: "printf 'literal\r\npart' {{first}}; rm -rf /tmp/{{second}}",
    description: "Resolve\nvalues before execution",
    placeholders: [
      { name: "first", description: "First\r\nvalue" },
      { name: "second", description: "Second\r\nvalue" },
    ],
  };
  const firstValue = "A\r\nB";
  const secondValue = "C\nD\rE";
  const expectedCommand = `printf 'literal\r\npart' ${firstValue}; rm -rf /tmp/${secondValue}`;
  let finalCommand: string | undefined;
  let errorCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 120, rows: 24 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "? Select a command");
  await send(view, "\r");
  await waitForOutput(view, "? Fill command placeholders");

  const firstInputOffset = view.output().length;
  await send(view, `\u001B[200~${firstValue}\u001B[201~`);
  await waitForOutputAfter(view, firstInputOffset, "A␍␊B");
  const firstInputOutput = stripVTControlCharacters(view.output().slice(firstInputOffset));
  assert.match(firstInputOutput, /literal␍␊part' A␍␊B/);
  assert.match(firstInputOutput, /^> A␍␊B[ \t]*$/m);

  const resolvedFirstOffset = view.output().length;
  await send(view, "\r");
  await waitForOutputAfter(view, resolvedFirstOffset, "second: Second␍␊value");
  await waitForOutputAfter(view, resolvedFirstOffset, "A␍␊B");

  const secondInputOffset = view.output().length;
  await send(view, `\u001B[200~${secondValue}\u001B[201~`);
  await waitForOutputAfter(view, secondInputOffset, "C␊D␍E");

  const confirmationOffset = view.output().length;
  await send(view, "\r");
  await waitForOutputAfter(view, confirmationOffset, "EXECUTE+Enter; Esc/Ctrl+C |>");
  await waitForOutputAfter(view, confirmationOffset, "literal␍␊part");
  await waitForOutputAfter(view, confirmationOffset, "A␍␊B");
  await waitForOutputAfter(view, confirmationOffset, "C␊D␍E");

  for (const character of "EXECUTE") {
    await send(view, character);
  }
  await send(view, "\r");
  await waitFor(() => finalCommand !== undefined, "App did not confirm the resolved command");

  assert.equal(finalCommand, expectedCommand);
  assert.ok(!finalCommand.includes("␍"));
  assert.ok(!finalCommand.includes("␊"));
  assert.equal(errorCount, 0);
  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("ConfirmView accepts a typed uppercase EXECUTE confirmation", async (t) => {
  let confirmations = 0;
  let cancellations = 0;
  const { ConfirmView } = await uiModules;
  const view = await renderView(
    <ConfirmView
      candidate={placeholderCandidate()}
      command="rm -rf /tmp/example"
      resolvedValues={new Map()}
      danger={danger()}
      onConfirm={() => {
        confirmations++;
      }}
      onCancel={() => {
        cancellations++;
      }}
    />,
  );
  t.after(() => close(view));

  for (const character of "EXECUTE") {
    await send(view, character);
  }
  await send(view, "\r");

  assert.equal(confirmations, 1);
  assert.equal(cancellations, 0);
});

void test("ConfirmView accepts a bracketed-paste EXECUTE confirmation", async (t) => {
  let confirmations = 0;
  const { ConfirmView } = await uiModules;
  const view = await renderView(
    <ConfirmView
      candidate={placeholderCandidate()}
      command="rm -rf /tmp/example"
      resolvedValues={new Map()}
      danger={danger()}
      onConfirm={() => {
        confirmations++;
      }}
      onCancel={() => {}}
    />,
  );
  t.after(() => close(view));

  await send(view, "\u001B[200~EXECUTE\u001B[201~");
  await send(view, "\r");

  assert.equal(confirmations, 1);
});

void test("ResolvePlaceholdersView keeps Enter, Backspace, Delete, Escape, and Ctrl+C behavior", async (t) => {
  const { ResolvePlaceholdersView } = await uiModules;
  let resolvedCommand: string | undefined;
  let backCount = 0;
  let cancelCount = 0;
  const view = await renderView(
    <ResolvePlaceholdersView
      candidate={placeholderCandidate()}
      availableRows={10}
      availableColumns={120}
      onResolve={(resolved) => {
        resolvedCommand = resolved.command;
      }}
      onBack={() => {
        backCount++;
      }}
      onCancel={() => {
        cancelCount++;
      }}
    />,
  );
  t.after(() => close(view));

  await send(view, "A");
  await send(view, "\u007F");
  await send(view, "B");
  await send(view, "\u001B[3~");
  await send(view, "C");
  await send(view, "\r");

  assert.equal(resolvedCommand, "printf '%s' C");

  const backView = await renderView(
    <ResolvePlaceholdersView
      candidate={placeholderCandidate()}
      availableRows={10}
      availableColumns={120}
      onResolve={() => {}}
      onBack={() => {
        backCount++;
      }}
      onCancel={() => {}}
    />,
  );
  t.after(() => close(backView));
  await sendEscape(backView);

  const cancelView = await renderView(
    <ResolvePlaceholdersView
      candidate={placeholderCandidate()}
      availableRows={10}
      availableColumns={120}
      onResolve={() => {}}
      onBack={() => {}}
      onCancel={() => {
        cancelCount++;
      }}
    />,
  );
  t.after(() => close(cancelView));
  await send(cancelView, "\u0003");

  assert.equal(backCount, 1);
  assert.equal(cancelCount, 1);
});

void test("ConfirmView keeps safe Enter, cancellation, and failed-danger-confirmation behavior", async (t) => {
  const { ConfirmView } = await uiModules;
  let safeConfirmations = 0;
  let cancellations = 0;
  const safeView = await renderView(
    <ConfirmView
      candidate={placeholderCandidate()}
      command="printf '%s' safe"
      resolvedValues={new Map()}
      onConfirm={() => {
        safeConfirmations++;
      }}
      onCancel={() => {
        cancellations++;
      }}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(() => close(safeView));
  await send(safeView, "\r");

  const failedDangerView = await renderView(
    <ConfirmView
      candidate={placeholderCandidate()}
      command="rm -rf /tmp/example"
      resolvedValues={new Map()}
      danger={danger()}
      onConfirm={() => {}}
      onCancel={() => {
        cancellations++;
      }}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(() => close(failedDangerView));
  await send(failedDangerView, "\u001B[200~EXECUTE!\u001B[201~");
  await send(failedDangerView, "\r");

  const escapeView = await renderView(
    <ConfirmView
      candidate={placeholderCandidate()}
      command="printf '%s' safe"
      resolvedValues={new Map()}
      onConfirm={() => {}}
      onCancel={() => {
        cancellations++;
      }}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(() => close(escapeView));
  await sendEscape(escapeView);

  const ctrlCView = await renderView(
    <ConfirmView
      candidate={placeholderCandidate()}
      command="printf '%s' safe"
      resolvedValues={new Map()}
      onConfirm={() => {}}
      onCancel={() => {
        cancellations++;
      }}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(() => close(ctrlCView));
  await send(ctrlCView, "\u0003");

  assert.equal(safeConfirmations, 1);
  assert.equal(cancellations, 3);
});

void test("SelectCommandView pages with arrow keys and selects the visible candidate", async (t) => {
  const { SelectCommandView } = await uiModules;
  const candidates = [
    candidate("First candidate", "printf first", "First description"),
    candidate(
      "Second candidate with a title wider than the terminal",
      "printf second-with-a-long-command-suffix",
      "Second description that is not shown in four rows",
    ),
  ];
  let selectedCandidate: CommandCandidateContract | undefined;
  const view = await renderView(
    <SelectCommandView
      candidates={candidates}
      availableRows={4}
      onSelect={(selected) => {
        selectedCandidate = selected;
      }}
      onCancel={() => {}}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(() => close(view));

  await waitForOutput(view, "? Select a command (1/2)");
  await send(view, "\u001B[B");
  await waitForOutput(view, "? Select a command (2/2)");
  await send(view, "\r");

  assert.equal(selectedCandidate, candidates[1]);
});

void test("App preserves selection and ignores hidden input across repeated one-row resizes", async (t) => {
  const { App } = await uiModules;
  const generatedCandidates = [
    candidate("First candidate", "printf first", "First description"),
    candidate("Second candidate", "printf second", "Second description"),
  ];
  let finalCommand: string | undefined;
  let errorCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: generatedCandidates }) }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "? Select (1/2)");
  await send(view, "\u001B[B");
  await waitForOutput(view, "? Select (2/2)");

  for (const hiddenArrow of ["\u001B[A", "\u001B[B"]) {
    await resizeToHiddenFrame(view);
    assert.equal(view.stdin.rawModeEnabled, true);
    await send(view, hiddenArrow);
    await send(view, "\r");
    await sendEscape(view);
    await send(view, "\u0003");
    assert.equal(finalCommand, undefined);
    assert.equal(errorCount, 0);

    const restoredOutput = await restoreFrame(view, 4, "? Select (2/2)");
    assert.ok(restoredOutput.includes("? Select (2/2)"));
  }

  await send(view, "\r");
  await waitForOutput(view, "Final command: printf second");
  assert.equal(finalCommand, undefined);
  assert.equal(errorCount, 0);

  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("App preserves placeholder input and ignores hidden editing and cancellation", async (t) => {
  const { App } = await uiModules;
  let finalCommand: string | undefined;
  let errorCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [placeholderCandidate()] }) }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 60, rows: 12 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "? Select a command");
  await send(view, "\r");
  await waitForOutput(view, "? Fill command placeholders");
  await send(view, "A");
  await send(view, "b");
  await waitForOutput(view, "Ab");

  await resizeToHiddenFrame(view);
  assert.equal(view.stdin.rawModeEnabled, true);
  await send(view, "X");
  await send(view, "\u007F");
  await send(view, "\u001B[3~");
  await send(view, "\r");
  await sendEscape(view);
  await send(view, "\u0003");
  assert.equal(finalCommand, undefined);
  assert.equal(errorCount, 0);

  const restoredOutput = await restoreFrame(view, 12, "? Fill command placeholders");
  assert.match(stripVTControlCharacters(restoredOutput), /> Ab\s/);
  await send(view, "C");
  await send(view, "\r");
  await waitForOutput(view, "Final command: printf '%s' AbC");
  await send(view, "\r");
  await waitFor(() => finalCommand !== undefined, "App did not confirm the resolved command");

  assert.equal(finalCommand, "printf '%s' AbC");
  assert.equal(errorCount, 0);
  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("App preserves compact placeholder input through visible and hidden resizes", async () => {
  const { App } = await uiModules;
  const pastedValue = "prefixA\r\nB👩🏽‍💻";
  const expectedCommand = `printf '%s' ${pastedValue}`;
  let finalCommand: string | undefined;
  let errorCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [placeholderCandidate()] }) }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 20, rows: 12 },
  );

  try {
    await waitForOutput(view, "? Select a command");
    await send(view, "\r");
    await waitForOutput(view, "? value: Value");
    await send(view, `\u001B[200~${pastedValue}\u001B[201~`);
    await waitForOutput(view, "prefixA␍␊B👩🏽‍💻");

    let outputOffset = view.output().length;
    view.stdout.resize(20, 4);
    await waitForOutputAfter(view, outputOffset, "Enter=next Esc=back");
    await settleUpdates(view);
    let compactOutput = stripVTControlCharacters(view.output().slice(outputOffset)).trim();
    assert.equal(compactOutput.split("\n").length, 3);
    assert.ok(compactOutput.includes("? value: Value"));
    assert.ok(compactOutput.includes("prefixA␍␊B👩🏽‍💻"));

    outputOffset = view.output().length;
    view.stdout.resize(20, 3);
    await waitForOutputAfter(view, outputOffset, " Ent Esc");
    await settleUpdates(view);
    compactOutput = stripVTControlCharacters(view.output().slice(outputOffset)).trim();
    assert.equal(compactOutput.split("\n").length, 2);
    assert.ok(compactOutput.includes("? value: Value"));
    assert.ok(compactOutput.includes("B👩🏽‍💻"));

    outputOffset = view.output().length;
    view.stdout.resize(20, 2);
    await waitForOutputAfter(view, outputOffset, "value:");
    await settleUpdates(view);
    compactOutput = stripVTControlCharacters(view.output().slice(outputOffset)).trim();
    assert.equal(compactOutput.split("\n").length, 1);
    assert.ok(compactOutput.startsWith("value:"));
    assert.ok(compactOutput.includes("␍␊B👩🏽‍💻"));
    assert.ok(compactOutput.endsWith(" Ent Esc"));

    await resizeToHiddenFrame(view);
    await send(view, "X");
    await send(view, "\u007F");
    await send(view, "\r");
    await sendEscape(view);
    await send(view, "\u0003");
    assert.equal(finalCommand, undefined);
    assert.equal(errorCount, 0);

    const restoredOutput = stripVTControlCharacters(await restoreFrame(view, 2, "value:")).trim();
    assert.ok(restoredOutput.startsWith("value:"));
    assert.ok(restoredOutput.includes("␍␊B👩🏽‍💻"));
    assert.ok(restoredOutput.endsWith(" Ent Esc"));

    await send(view, "\r");
    await waitForOutput(view, " Enter Esc");
    await send(view, "\r");
    await waitFor(() => finalCommand !== undefined, "App did not execute the restored input");

    assert.equal(finalCommand, expectedCommand);
    assert.equal(errorCount, 0);
    await clearAndUnmount(view);
    unmounted = true;
    assertTerminalCleanup(view);
  } finally {
    if (!unmounted) {
      await close(view);
    }
  }
});

void test("App preserves dangerous confirmation input and ignores hidden confirmation", async (t) => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Remove temporary files",
    "rm -rf /tmp/howto-example",
    "Remove a temporary directory",
  );
  let finalCommand: string | undefined;
  let errorCount = 0;
  let successCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
        successCount++;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 60, rows: 4 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "? Select (1/1)");
  await send(view, "\r");
  await waitForOutput(view, "EXECUTE+Enter; Esc/Ctrl+C |>");
  await send(view, "E");
  await send(view, "X");

  await resizeToHiddenFrame(view);
  assert.equal(view.stdin.rawModeEnabled, true);
  for (const character of "ECUTE") {
    await send(view, character);
  }
  await send(view, "\r");
  await sendEscape(view);
  await send(view, "\u0003");
  assert.equal(successCount, 0);
  assert.equal(errorCount, 0);

  const restoredOutput = await restoreFrame(view, 4, "EXECUTE+Enter; Esc/Ctrl+C |>");
  assert.match(stripVTControlCharacters(restoredOutput), /\|>\s+EX\s/);
  for (const character of "ECUTE") {
    await send(view, character);
  }
  await send(view, "\r");
  await waitFor(() => successCount === 1, "App did not confirm the dangerous command");

  assert.equal(finalCommand, generatedCandidate.command);
  assert.equal(errorCount, 0);
  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("App keeps safe confirmation visible and executable in a three-row terminal", async () => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Print safely",
    "printf abcdefghijklmnopqrstuvwxyz",
    "Print a safe value",
  );
  let finalCommand: string | undefined;
  let errorCount = 0;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 20, rows: 4 },
  );

  try {
    await waitForOutput(view, "? Select (1/1)");
    await send(view, "\r");
    await waitForOutput(view, "Enter execute");

    const outputOffset = view.output().length;
    view.stdout.resize(20, 3);
    await waitForOutputAfter(view, outputOffset, "Enter=run Esc=cancel");
    await settleUpdates(view);
    const resizedLines = stripVTControlCharacters(view.output().slice(outputOffset))
      .trim()
      .split("\n");
    assert.equal(resizedLines.length, 2);
    assert.ok(resizedLines[0]?.startsWith("Final: printf"));
    assert.equal(resizedLines[1], "Enter=run Esc=cancel");

    await send(view, "\r");
    await waitFor(() => finalCommand !== undefined, "App did not execute the safe command");
    assert.equal(finalCommand, generatedCandidate.command);
    assert.equal(errorCount, 0);
    await clearAndUnmount(view);
    assertTerminalCleanup(view);
  } finally {
    if (view.stdin.rawModeEnabled) {
      await close(view);
    }
  }
});

void test("App keeps a complete dangerous input tail when columns shrink from forty to twenty", async () => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Remove temporary files",
    "rm -rf /tmp/abcdefghijklmnopqrstuvwxyz",
    "Remove a temporary directory",
  );
  let successCount = 0;
  let errorCount = 0;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={appRequest()}
      onSuccess={() => {
        successCount++;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 40, rows: 3 },
  );

  try {
    await waitForOutput(view, "? 1/1");
    await send(view, "\r");
    await waitForOutput(view, "X=EXECUTE:");
    await send(view, "\u001B[200~ABEX\u001B[201~");

    const outputOffset = view.output().length;
    view.stdout.resize(20, 3);
    await waitForOutputAfter(view, outputOffset, "X=EXECUTE:EX Ent Esc");
    await settleUpdates(view);
    const resizedLines = stripVTControlCharacters(view.output().slice(outputOffset))
      .trim()
      .split("\n");
    const resizedFrame = resizedLines.slice(-2);
    assert.equal(resizedFrame.length, 2);
    assert.ok(resizedFrame[0]?.startsWith("Danger: rm"));
    assert.equal(resizedFrame[1], "X=EXECUTE:EX Ent Esc");
    assert.equal(successCount, 0);
    assert.equal(errorCount, 0);

    await sendEscape(view);
    await waitFor(() => errorCount === 1, "App did not cancel the compact confirmation");
    assert.equal(successCount, 0);
    await clearAndUnmount(view);
    assertTerminalCleanup(view);
  } finally {
    if (view.stdin.rawModeEnabled) {
      await close(view);
    }
  }
});

void test("App cancels partial and wrong dangerous confirmations at compact heights", async () => {
  const generatedCandidate = candidate(
    "Remove temporary files",
    "rm -rf /tmp/abcdefghijklmnopqrstuvwxyz",
    "Remove a temporary directory",
  );

  for (const scenario of [
    { rows: 3, input: "EX", expected: "X=EXECUTE:", tailPattern: /^X=EXECUTE:EX Ent Esc$/u },
    { rows: 3, input: "执行", expected: "X=EXECUTE:", tailPattern: /^X=EXECUTE:行 Ent Esc$/u },
    { rows: 2, input: "EXECUTE!", expected: "!X:", tailPattern: /!X:XECUTE! Ent Esc$/u },
    { rows: 2, input: "EXEC你好世界", expected: "!X:", tailPattern: /!X:\s*好世界 Ent Esc$/u },
  ]) {
    const { App } = await uiModules;
    let successCount = 0;
    let errorCount = 0;
    const view = await renderView(
      <App
        provider={{
          generateCommands: () =>
            Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
        }}
        request={appRequest()}
        onSuccess={() => {
          successCount++;
        }}
        onError={() => {
          errorCount++;
        }}
      />,
      { columns: 20, rows: 4 },
    );

    try {
      await waitForOutput(view, "? Select (1/1)");
      await send(view, "\r");
      await waitForOutput(view, "Risk:");
      for (const character of scenario.input) {
        await send(view, character);
      }

      const outputOffset = view.output().length;
      view.stdout.resize(20, scenario.rows);
      await waitForOutputAfter(view, outputOffset, scenario.expected);
      await settleUpdates(view);
      const resizedLines = stripVTControlCharacters(view.output().slice(outputOffset))
        .trim()
        .split("\n");
      assert.equal(resizedLines.length, scenario.rows - 1);
      assert.ok(resizedLines.at(-1)?.endsWith(" Ent Esc"));
      if (scenario.tailPattern !== undefined) {
        assert.match(resizedLines.at(-1) ?? "", scenario.tailPattern);
      }

      await send(view, "\r");
      await waitFor(() => errorCount === 1, "App did not cancel an invalid danger phrase");
      assert.equal(successCount, 0);
      await clearAndUnmount(view);
      assertTerminalCleanup(view);
    } finally {
      if (view.stdin.rawModeEnabled) {
        await close(view);
      }
    }
  }
});

void test("App preserves compact danger input across visible and hidden terminal heights", async () => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Remove temporary files",
    "rm -rf /tmp/abcdefghijklmnopqrstuvwxyz",
    "Remove a temporary directory",
  );
  let finalCommand: string | undefined;
  let errorCount = 0;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 20, rows: 3 },
  );

  try {
    await waitForOutput(view, "? 1/1");
    await send(view, "\r");
    await waitForOutput(view, "X=EXECUTE:");
    await send(view, "E");
    await send(view, "X");

    let outputOffset = view.output().length;
    view.stdout.resize(20, 2);
    await waitForOutputAfter(view, outputOffset, "!X:");
    await settleUpdates(view);
    let resizedOutput = stripVTControlCharacters(view.output().slice(outputOffset)).trim();
    assert.equal(resizedOutput.split("\n").length, 1);
    assert.match(resizedOutput, /^.{2}!X:\s*EX\s+Ent Esc$/u);

    await resizeToHiddenFrame(view);
    await resizeHiddenFrame(view, 0);
    for (const character of "ECUTE") {
      await send(view, character);
    }
    await send(view, "\u007F");
    await send(view, "\r");
    await sendEscape(view);
    await send(view, "\u0003");
    assert.equal(finalCommand, undefined);
    assert.equal(errorCount, 0);
    assert.equal(view.stdin.readableLength, 0);

    outputOffset = view.output().length;
    view.stdout.resize(20, 2);
    await waitForOutputAfter(view, outputOffset, "!X:");
    await settleUpdates(view);
    resizedOutput = stripVTControlCharacters(view.output().slice(outputOffset)).trim();
    assert.match(resizedOutput, /!X:\s*EX\s+Ent Esc$/u);

    for (const character of "ECUTE") {
      await send(view, character);
    }
    await send(view, "\r");
    await waitFor(
      () => finalCommand !== undefined,
      "App did not confirm the restored danger input",
    );
    assert.equal(finalCommand, generatedCandidate.command);
    assert.equal(errorCount, 0);
    await clearAndUnmount(view);
    assertTerminalCleanup(view);
  } finally {
    if (view.stdin.rawModeEnabled) {
      await close(view);
    }
  }
});

void test("App ignores hidden input after a deferred provider resolves in one row", async (t) => {
  const { App } = await uiModules;
  const generatedCandidates = [
    candidate("First candidate", "printf first", "First description"),
    candidate("Second candidate", "printf second", "Second description"),
  ];
  let resolveProvider: ((response: { rawText: string }) => void) | undefined;
  const providerResponse = new Promise<{ rawText: string }>((resolve) => {
    resolveProvider = resolve;
  });
  let finalCommand: string | undefined;
  let errorCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{ generateCommands: () => providerResponse }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 40, rows: 1 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  assert.equal(stripVTControlCharacters(view.output()).trim(), "");
  assert.ok(resolveProvider);
  resolveProvider({ rawText: JSON.stringify({ commands: generatedCandidates }) });
  await settleUpdates(view);
  assert.equal(view.stdin.rawModeEnabled, true);
  assert.ok(view.stdin.listenerCount("readable") > view.stdinReadableListenerBaseline);

  await send(view, "\u001B[B");
  await send(view, "\r");
  await sendEscape(view);
  await send(view, "\u0003");
  assert.equal(finalCommand, undefined);
  assert.equal(errorCount, 0);

  const restoredOutput = await restoreFrame(view, 4, "? Select (1/2)");
  assert.ok(restoredOutput.includes("? Select (1/2)"));
  await send(view, "\r");
  await waitForOutput(view, "Final command: printf first");

  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("App consumes hidden input while the provider is still pending", async (t) => {
  const { App } = await uiModules;
  const generatedCandidates = [
    candidate("First candidate", "printf first", "First description"),
    candidate("Second candidate", "printf second", "Second description"),
  ];
  let resolveProvider: ((response: { rawText: string }) => void) | undefined;
  const providerResponse = new Promise<{ rawText: string }>((resolve) => {
    resolveProvider = resolve;
  });
  let finalCommand: string | undefined;
  let errorCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{ generateCommands: () => providerResponse }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 40, rows: 1 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await settleUpdates(view);
  assert.equal(view.stdin.rawModeEnabled, true);
  assert.ok(view.stdin.listenerCount("readable") > view.stdinReadableListenerBaseline);
  await send(view, "\u001B[B");
  await send(view, "\r");
  await sendEscape(view);
  await send(view, "\u0003");

  const loadingOutput = await restoreFrame(view, 4, "Thinking...");
  assert.ok(loadingOutput.includes("Thinking..."));
  assert.equal(finalCommand, undefined);
  assert.equal(errorCount, 0);

  const providerOutputOffset = view.output().length;
  assert.ok(resolveProvider);
  resolveProvider({ rawText: JSON.stringify({ commands: generatedCandidates }) });
  await waitForOutputAfter(view, providerOutputOffset, "? Select (1/2)");
  await settleUpdates(view);
  assert.equal(finalCommand, undefined);
  assert.equal(errorCount, 0);
  await send(view, "\r");
  await waitForOutput(view, "Final command: printf first");

  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("App keeps selection commands and controls visible through four, three, and two rows", async (t) => {
  const { App } = await uiModules;
  const generatedCandidates = [
    candidate("First candidate", "pwd", "First description"),
    candidate("Second candidate", "ls", "Second description"),
    candidate("Third candidate", "date", "Third description"),
  ];
  let resolveProvider: ((response: { rawText: string }) => void) | undefined;
  const providerResponse = new Promise<{ rawText: string }>((resolve) => {
    resolveProvider = resolve;
  });
  let finalCommand: string | undefined;
  let errorCount = 0;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{ generateCommands: () => providerResponse }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={() => {
        errorCount++;
      }}
    />,
    { columns: 20, rows: 4 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "Thinking...");
  const selectionOutputOffset = view.output().length;
  assert.ok(resolveProvider);
  resolveProvider({ rawText: JSON.stringify({ commands: generatedCandidates }) });
  await waitForOutputAfter(view, selectionOutputOffset, "? Select (1/3)");
  await settleUpdates(view);
  const firstSelectionOutput = stripVTControlCharacters(view.output().slice(selectionOutputOffset));
  assert.ok(firstSelectionOutput.includes("Fir"));
  assert.ok(firstSelectionOutput.includes("pwd"));
  assert.ok(firstSelectionOutput.includes("↑↓; Enter; Esc/^C"));

  const secondSelectionOutputOffset = view.output().length;
  await send(view, "\u001B[B");
  await waitForOutputAfter(view, secondSelectionOutputOffset, "? Select (2/3)");
  await settleUpdates(view);
  const secondSelectionOutput = stripVTControlCharacters(
    view.output().slice(secondSelectionOutputOffset),
  );
  assert.ok(secondSelectionOutput.includes("Sec"));
  assert.ok(secondSelectionOutput.includes("ls"));
  assert.ok(secondSelectionOutput.includes("↑↓; Enter; Esc/^C"));

  const twoRowOutputOffset = view.output().length;
  view.stdout.resize(20, 3);
  await waitForOutputAfter(view, twoRowOutputOffset, "? 2/3 ls");
  await settleUpdates(view);
  const twoRowOutput = stripVTControlCharacters(view.output().slice(twoRowOutputOffset));
  assert.ok(twoRowOutput.includes("? 2/3 ls"));
  assert.ok(twoRowOutput.includes("↑↓; Enter; Esc/^C"));

  const thirdSelectionOutputOffset = view.output().length;
  await send(view, "\u001B[B");
  await waitForOutputAfter(view, thirdSelectionOutputOffset, "? 3/3 date");
  const thirdSelectionOutput = stripVTControlCharacters(
    view.output().slice(thirdSelectionOutputOffset),
  );
  assert.ok(thirdSelectionOutput.includes("? 3/3 date"));
  assert.ok(thirdSelectionOutput.includes("↑↓; Enter; Esc/^C"));

  const oneRowOutputOffset = view.output().length;
  view.stdout.resize(20, 2);
  await waitForOutputAfter(view, oneRowOutputOffset, "3/3 UD Enter Esc");
  await settleUpdates(view);
  const oneRowOutput = stripVTControlCharacters(view.output().slice(oneRowOutputOffset));
  assert.match(oneRowOutput, /^dat 3\/3 UD Enter Esc$/m);

  const restoredSecondOutputOffset = view.output().length;
  await send(view, "\u001B[A");
  await waitForOutputAfter(view, restoredSecondOutputOffset, "2/3 UD Enter Esc");
  const restoredSecondOutput = stripVTControlCharacters(
    view.output().slice(restoredSecondOutputOffset),
  );
  assert.match(restoredSecondOutput, /^ls[ \t]+2\/3 UD Enter Esc$/m);

  await send(view, "\r");
  const restoredConfirmationOffset = view.output().length;
  view.stdout.resize(20, 4);
  await waitForOutputAfter(view, restoredConfirmationOffset, "Final command: ls");
  await waitForOutputAfter(view, restoredConfirmationOffset, "Enter execute");
  await send(view, "\r");
  await waitFor(() => finalCommand !== undefined, "App did not confirm the selected command");

  assert.equal(finalCommand, generatedCandidates[1].command);
  assert.equal(errorCount, 0);
  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("App cancels visible loading exactly once on Ctrl+C", async (t) => {
  const { App } = await uiModules;
  const providerResponse = createDeferred<{ rawText: string }>();
  const errors: Error[] = [];
  let providerSignal: AbortSignal | undefined;
  let signalWasAbortedWhenCancelled = false;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: (_request, signal) => {
          providerSignal = signal;
          signal?.addEventListener(
            "abort",
            () => {
              providerResponse.reject(new Error("provider aborted"));
            },
            { once: true },
          );
          return providerResponse.promise;
        },
      }}
      request={appRequest()}
      onSuccess={() => {}}
      onError={(error) => {
        signalWasAbortedWhenCancelled = providerSignal?.aborted === true;
        errors.push(error);
      }}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "Thinking...");
  await send(view, "\u0003");
  await waitFor(() => errors.length === 1, "App did not cancel visible loading");
  await send(view, "\u0003");
  await settleUpdates(view);

  assert.ok(providerSignal);
  assert.equal(providerSignal.aborted, true);
  assert.equal(signalWasAbortedWhenCancelled, true);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof InteractionCancelledError);
  assert.equal(toAppError(errors[0]).exitCode, 130);

  await clearAndUnmount(view);
  unmounted = true;
  assertTerminalCleanup(view);
});

void test("App ignores late provider resolution and rejection after loading cancellation", async () => {
  const { App } = await uiModules;

  for (const outcome of ["resolve", "reject"] as const) {
    const providerResponse = createDeferred<{ rawText: string }>();
    const errors: Error[] = [];
    let providerSignal: AbortSignal | undefined;
    let successCount = 0;
    const lateCandidate = candidate(
      `Late ${outcome} candidate`,
      `printf late-${outcome}`,
      "Must stay hidden after cancellation",
    );
    const view = await renderView(
      <App
        provider={{
          generateCommands: (_request, signal) => {
            providerSignal = signal;
            return providerResponse.promise;
          },
        }}
        request={appRequest()}
        onSuccess={() => {
          successCount++;
        }}
        onError={(error) => {
          errors.push(error);
        }}
      />,
      { columns: 40, rows: 4 },
    );

    try {
      await waitForOutput(view, "Thinking...");
      await send(view, "\u0003");
      await waitFor(() => errors.length === 1, `App did not cancel before late ${outcome}`);
      assert.ok(providerSignal);
      assert.equal(providerSignal.aborted, true);
      const lateOutputOffset = view.output().length;

      if (outcome === "resolve") {
        providerResponse.resolve({ rawText: JSON.stringify({ commands: [lateCandidate] }) });
      } else {
        providerResponse.reject(new Error("late provider failure"));
      }
      await settleUpdates(view);

      const lateOutput = view.output().slice(lateOutputOffset);
      assert.equal(errors.length, 1);
      assert.ok(errors[0] instanceof InteractionCancelledError);
      assert.equal(successCount, 0);
      assert.ok(!lateOutput.includes(lateCandidate.title));
      assert.ok(!lateOutput.includes("Error:"));
    } finally {
      await close(view);
    }
  }
});

void test("App aborts on unmount and ignores providers that settle afterward", async () => {
  const { App } = await uiModules;

  for (const outcome of ["resolve", "reject"] as const) {
    const providerResponse = createDeferred<{ rawText: string }>();
    const errors: Error[] = [];
    let providerSignal: AbortSignal | undefined;
    let successCount = 0;
    const view = await renderView(
      <App
        provider={{
          generateCommands: (_request, signal) => {
            providerSignal = signal;
            return providerResponse.promise;
          },
        }}
        request={appRequest()}
        onSuccess={() => {
          successCount++;
        }}
        onError={(error) => {
          errors.push(error);
        }}
      />,
      { columns: 40, rows: 4 },
    );

    await waitForOutput(view, "Thinking...");
    await close(view);
    assert.ok(providerSignal);
    assert.equal(providerSignal.aborted, true);
    const outputAfterUnmount = view.output();

    if (outcome === "resolve") {
      providerResponse.resolve({
        rawText: JSON.stringify({
          commands: [candidate("Unmounted candidate", "printf unmounted", "Must stay hidden")],
        }),
      });
    } else {
      providerResponse.reject(new Error("failure after unmount"));
    }
    await settlePromises();

    assert.equal(view.output(), outputAfterUnmount);
    assert.equal(successCount, 0);
    assert.deepEqual(errors, []);
  }
});

void test("App aborts superseded request dependencies and ignores both stale outcomes", async (t) => {
  const { App } = await uiModules;
  const firstResponse = createDeferred<{ rawText: string }>();
  const secondResponse = createDeferred<{ rawText: string }>();
  const currentResponse = createDeferred<{ rawText: string }>();
  const requests = new Map([
    ["first request", firstResponse],
    ["second request", secondResponse],
    ["current request", currentResponse],
  ]);
  const signals: AbortSignal[] = [];
  const errors: Error[] = [];
  let successCount = 0;
  const provider = {
    generateCommands: (request: ReturnType<typeof appRequest>, signal?: AbortSignal) => {
      if (signal !== undefined) signals.push(signal);
      const response = requests.get(request.question);
      if (response === undefined) throw new Error("unexpected request");
      return response.promise;
    },
  };
  const handleSuccess = () => {
    successCount++;
  };
  const handleError = (error: Error) => {
    errors.push(error);
  };
  const view = await renderView(
    <App
      provider={provider}
      request={{ ...appRequest(), question: "first request" }}
      onSuccess={handleSuccess}
      onError={handleError}
    />,
    { columns: 60, rows: 12 },
  );
  t.after(() => close(view));

  await waitFor(() => signals.length === 1, "App did not start the first request");
  view.instance.rerender(
    <App
      provider={provider}
      request={{ ...appRequest(), question: "second request" }}
      onSuccess={handleSuccess}
      onError={handleError}
    />,
  );
  await waitFor(() => signals.length === 2, "App did not start the second request");
  assert.equal(signals[0].aborted, true);

  firstResponse.resolve({
    rawText: JSON.stringify({
      commands: [candidate("Stale resolved candidate", "printf stale", "Must be ignored")],
    }),
  });
  await settleUpdates(view);
  assert.ok(!view.output().includes("Stale resolved candidate"));

  view.instance.rerender(
    <App
      provider={provider}
      request={{ ...appRequest(), question: "current request" }}
      onSuccess={handleSuccess}
      onError={handleError}
    />,
  );
  await waitFor(() => signals.length === 3, "App did not start the current request");
  assert.equal(signals[1].aborted, true);

  secondResponse.reject(new Error("stale rejected request"));
  await settleUpdates(view);
  assert.deepEqual(errors, []);
  assert.ok(!view.output().includes("Error:"));

  currentResponse.resolve({
    rawText: JSON.stringify({
      commands: [candidate("Current candidate", "printf current", "Must be displayed")],
    }),
  });
  await waitForOutput(view, "Current candidate");
  assert.equal(successCount, 0);
  assert.deepEqual(errors, []);
});

void test("App still reports a current provider failure through the existing error state", async (t) => {
  const { App } = await uiModules;
  const errors: Error[] = [];
  let successCount = 0;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () => Promise.reject(new AiProviderError("openai", "fixed-model")),
      }}
      request={appRequest()}
      onSuccess={() => {
        successCount++;
      }}
      onError={(error) => {
        errors.push(error);
      }}
    />,
    { columns: 80, rows: 24 },
  );
  t.after(() => close(view));

  await waitFor(() => errors.length === 1, "App did not report the provider failure");
  await waitForOutput(
    view,
    "Error: AI provider request failed (provider: openai, model: fixed-model)",
  );

  assert.equal(successCount, 0);
  assert.ok(errors[0] instanceof AiProviderError);
});

void test("ConfirmView accepts EXECUTE in a narrow four-row fake TTY", async (t) => {
  const { ConfirmView } = await uiModules;
  let confirmations = 0;
  const view = await renderView(
    <ConfirmView
      candidate={candidate(
        "Dangerous candidate with a long title",
        "rm -rf /tmp/example",
        "Long description that must not hide confirmation controls",
      )}
      command={`rm -rf /tmp/${"nested/".repeat(8)}example`}
      resolvedValues={new Map()}
      danger={danger()}
      onConfirm={() => {
        confirmations++;
      }}
      onCancel={() => {}}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(() => close(view));

  await waitForOutput(view, "Final command:");
  await waitForOutput(view, "EXECUTE+Enter; Esc/Ctrl+C |>");
  for (const character of "EXECUTE") {
    await send(view, character);
  }
  await send(view, "\r");

  assert.equal(confirmations, 1);
});

void test("App exposes final command and confirmation in a four-row terminal", async (t) => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Safe candidate with a title wider than the terminal",
    "printf first\nprintf second",
    "Long description that must not hide the final command",
  );
  let finalCommand: string | undefined;
  let appError: Error | undefined;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={{
        question: "print a value",
        arguments: [],
        structuredOutput: true,
        outputContract: "",
        safetyConstraints: "",
        systemPrompt: "",
        userPrompt: "",
      }}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={(error) => {
        appError = error;
      }}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(() => close(view));

  await waitForOutput(view, "? Select (1/1)");
  assert.ok(!view.output().includes("Long description that must not hide the final command"));
  await send(view, "\r");
  await waitForOutput(view, "Final command:");
  await waitForOutput(view, "printf first␊printf second");
  const confirmationBytes = view.outputBytes();
  assert.ok(confirmationBytes.includes(Buffer.from("printf first␊printf second")));
  assert.ok(!confirmationBytes.includes(Buffer.from(generatedCandidate.command)));
  await waitForOutput(view, "Enter execute; Esc/Ctrl+C cancel.");
  await send(view, "\r");
  await waitFor(() => finalCommand !== undefined, "App did not call onSuccess");

  assert.equal(finalCommand, generatedCandidate.command);
  assert.equal(appError, undefined);
});

void test("App rejects terminal control injection before writing AI command bytes to a fake TTY", async (t) => {
  const { App } = await uiModules;
  const attackCommand = `truncate -s 0 important.file #${"\b".repeat(40)}git status`;
  let finalCommand: string | undefined;
  let appError: Error | undefined;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({
            rawText: JSON.stringify({
              commands: [candidate("Inspect repository", attackCommand, "Show repository status")],
            }),
          }),
      }}
      request={appRequest()}
      onSuccess={(command) => {
        finalCommand = command;
      }}
      onError={(error) => {
        appError = error;
      }}
    />,
    { columns: 80, rows: 24 },
  );
  t.after(() => close(view));

  await waitFor(() => appError !== undefined, "App did not reject the injected command");
  await settleUpdates(view);

  const terminalBytes = view.outputBytes();
  assert.match(appError?.message ?? "", /commands\[0\]\.command.*control characters/u);
  assert.equal(finalCommand, undefined);
  assert.ok(!terminalBytes.includes(Buffer.from("\b")));
  assert.ok(!terminalBytes.includes(Buffer.from("truncate -s 0 important.file")));
  assert.ok(!terminalBytes.includes(Buffer.from("git status")));
  assert.ok(!terminalBytes.includes(Buffer.from("Final command:")));
});

void test("App does not reflect line breaks from an invalid placeholder into fake TTY bytes", async (t) => {
  const { App } = await uiModules;
  const injectedReference = "INJECTED_LEFT\r\nINJECTED_RIGHT";
  let successCount = 0;
  let appError: Error | undefined;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({
            rawText: JSON.stringify({
              commands: [
                candidate(
                  "Invalid placeholder",
                  `printf '{{${injectedReference}}}'`,
                  "Must fail validation",
                ),
              ],
            }),
          }),
      }}
      request={appRequest()}
      onSuccess={() => {
        successCount++;
      }}
      onError={(error) => {
        appError = error;
      }}
    />,
    { columns: 80, rows: 24 },
  );
  t.after(() => close(view));

  await waitFor(() => appError !== undefined, "App did not reject the invalid placeholder");
  await settleUpdates(view);

  const terminalBytes = view.outputBytes();
  assert.equal(appError?.message, "commands[0].command contains an invalid placeholder reference");
  assert.equal(successCount, 0);
  assert.ok(!terminalBytes.includes(Buffer.from("INJECTED_LEFT")));
  assert.ok(!terminalBytes.includes(Buffer.from("INJECTED_RIGHT")));
  assert.ok(!terminalBytes.includes(Buffer.from("Final command:")));
});

void test("App cleanup does not emit full-terminal clear sequences", async (t) => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Safe candidate",
    "printf safe",
    "Safe command used to verify terminal cleanup",
  );
  let finalCommand: string | undefined;
  let unmounted = false;

  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={{
        question: "print a value",
        arguments: [],
        structuredOutput: true,
        outputContract: "",
        safetyConstraints: "",
        systemPrompt: "",
        userPrompt: "",
      }}
      onSuccess={(command) => {
        finalCommand = command;
        view.instance.clear();
        view.instance.unmount();
        unmounted = true;
      }}
      onError={() => {}}
    />,
    { columns: 40, rows: 4 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "? Select (1/1)");
  await send(view, "\r");
  await waitForOutput(view, "Final command:");
  view.stdin.write("\r");
  await view.instance.waitUntilExit();
  view.stdin.end();

  assert.equal(finalCommand, generatedCandidate.command);
  assert.ok(!view.output().includes("\u001B[2J"));
  assert.ok(!view.output().includes("\u001B[3J"));
  assert.ok(!view.output().includes("\u001B[H"));
});

void test("App resize from 24 to 5 rows does not emit full-terminal clear sequences", async (t) => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Safe candidate",
    "printf safe",
    "Safe command used to verify resize cleanup",
  );
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={{
        question: "print a value",
        arguments: [],
        structuredOutput: true,
        outputContract: "",
        safetyConstraints: "",
        systemPrompt: "",
        userPrompt: "",
      }}
      onSuccess={() => {}}
      onError={() => {}}
    />,
    { columns: 80, rows: 24 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "Safe command used to verify resize cleanup");
  const resizeListenerBaseline = view.resizeListenerBaseline;
  assert.ok(view.stdout.listenerCount("resize") > resizeListenerBaseline);
  const outputLengthBeforeResize = view.output().length;
  view.stdout.resize(80, 5);
  await waitForOutputAfter(view, outputLengthBeforeResize, "? Select a command (1/1)");
  await view.instance.waitUntilRenderFlush();
  await clearAndUnmount(view);
  unmounted = true;

  const resizeOutput = view.output().slice(outputLengthBeforeResize);
  assert.ok(!resizeOutput.includes("\u001B[2J"));
  assert.ok(!resizeOutput.includes("\u001B[3J"));
  assert.ok(!resizeOutput.includes("\u001B[H"));
  assert.equal(view.stdout.listenerCount("resize"), resizeListenerBaseline);
});

void test("App resize from 24 to 0 rows commits an empty frame without full-terminal clear sequences", async (t) => {
  const { App } = await uiModules;
  const generatedCandidate = candidate(
    "Safe candidate",
    "printf safe",
    "Safe command used to verify empty resize cleanup",
  );
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: [generatedCandidate] }) }),
      }}
      request={{
        question: "print a value",
        arguments: [],
        structuredOutput: true,
        outputContract: "",
        safetyConstraints: "",
        systemPrompt: "",
        userPrompt: "",
      }}
      onSuccess={() => {}}
      onError={() => {}}
    />,
    { columns: 80, rows: 24 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "Safe command used to verify empty resize cleanup");
  const outputLengthBeforeResize = view.output().length;
  const renderCountBeforeResize = view.renderCount();
  view.stdout.resize(80, 0);
  await waitForCommittedFrame(view, renderCountBeforeResize, outputLengthBeforeResize);
  const committedResizeOutput = view.output().slice(outputLengthBeforeResize);
  assert.equal(stripVTControlCharacters(committedResizeOutput).trim(), "");
  await clearAndUnmount(view);
  unmounted = true;

  const resizeOutput = view.output().slice(outputLengthBeforeResize);
  assert.ok(!resizeOutput.includes("\u001B[2J"));
  assert.ok(!resizeOutput.includes("\u001B[3J"));
  assert.ok(!resizeOutput.includes("\u001B[H"));
});

void test("App resize across an expanded frame does not emit full-terminal clear sequences", async (t) => {
  const { App } = await uiModules;
  const generatedCandidates = [
    candidate("First candidate", "printf first", "First expanded description"),
    candidate("Second candidate", "printf second", "Second expanded description"),
    candidate("Third candidate", "printf third", "Third expanded description"),
  ];
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({ rawText: JSON.stringify({ commands: generatedCandidates }) }),
      }}
      request={{
        question: "print a value",
        arguments: [],
        structuredOutput: true,
        outputContract: "",
        safetyConstraints: "",
        systemPrompt: "",
        userPrompt: "",
      }}
      onSuccess={() => {}}
      onError={() => {}}
    />,
    { columns: 80, rows: 24 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await waitForOutput(view, "Third expanded description");
  const resizeListenerBaseline = view.resizeListenerBaseline;
  assert.ok(view.stdout.listenerCount("resize") > resizeListenerBaseline);
  const outputLengthBeforeResize = view.output().length;
  view.stdout.resize(80, 10);
  await waitForOutputAfter(view, outputLengthBeforeResize, "? Select a command (1/3)");
  await view.instance.waitUntilRenderFlush();
  await clearAndUnmount(view);
  unmounted = true;

  const resizeOutput = view.output().slice(outputLengthBeforeResize);
  assert.ok(!resizeOutput.includes("\u001B[2J"));
  assert.ok(!resizeOutput.includes("\u001B[3J"));
  assert.ok(!resizeOutput.includes("\u001B[H"));
  assert.equal(view.stdout.listenerCount("resize"), resizeListenerBaseline);
});

void test("App renders no frame in a one-row terminal", async (t) => {
  const { App } = await uiModules;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({
            rawText: JSON.stringify({ commands: [candidate("Safe", "printf safe", "Safe")] }),
          }),
      }}
      request={{
        question: "print a value",
        arguments: [],
        structuredOutput: true,
        outputContract: "",
        safetyConstraints: "",
        systemPrompt: "",
        userPrompt: "",
      }}
      onSuccess={() => {}}
      onError={() => {}}
    />,
    { columns: 40, rows: 1 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await clearAndUnmount(view);
  unmounted = true;

  assert.ok(!view.output().includes("Thinking"));
  assert.ok(!view.output().includes("\u001B[2J"));
  assert.ok(!view.output().includes("\u001B[3J"));
  assert.ok(!view.output().includes("\u001B[H"));
});

void test("App renders no visible frame when the terminal initially reports zero rows", async (t) => {
  const { App } = await uiModules;
  let unmounted = false;
  const view = await renderView(
    <App
      provider={{
        generateCommands: () =>
          Promise.resolve({
            rawText: JSON.stringify({ commands: [candidate("Safe", "printf safe", "Safe")] }),
          }),
      }}
      request={{
        question: "print a value",
        arguments: [],
        structuredOutput: true,
        outputContract: "",
        safetyConstraints: "",
        systemPrompt: "",
        userPrompt: "",
      }}
      onSuccess={() => {}}
      onError={() => {}}
    />,
    { columns: 40, rows: 0 },
  );
  t.after(async () => {
    if (!unmounted) {
      await close(view);
    }
  });

  await view.instance.waitUntilRenderFlush();
  await clearAndUnmount(view);
  unmounted = true;

  assert.equal(view.output().split("\u001B[?25h").join(""), "");
  assert.ok(!view.output().includes("\u001B[2J"));
  assert.ok(!view.output().includes("\u001B[3J"));
  assert.ok(!view.output().includes("\u001B[H"));
});

class FakeTty extends PassThrough {
  public readonly isTTY = true;
  public rawModeEnabled = false;

  public constructor(
    public columns = 120,
    public rows = 40,
  ) {
    super();
  }

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

  public resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

interface RenderedView {
  instance: Awaited<typeof uiModules>["render"] extends (...args: never[]) => infer Instance
    ? Instance
    : never;
  stdin: FakeTty;
  stdout: FakeTty;
  output: () => string;
  outputBytes: () => Buffer;
  renderCount: () => number;
  stdinReadableListenerBaseline: number;
  resizeListenerBaseline: number;
}

interface Viewport {
  columns: number;
  rows: number;
}

async function renderView(
  element: React.ReactNode,
  viewport: Viewport = { columns: 120, rows: 40 },
): Promise<RenderedView> {
  const { render, toResizeSafeOutput } = await uiModules;
  const stdin = new FakeTty(viewport.columns, viewport.rows);
  const stdout = new FakeTty(viewport.columns, viewport.rows);
  const stdinReadableListenerBaseline = stdin.listenerCount("readable");
  const resizeListenerBaseline = stdout.listenerCount("resize");
  let output = "";
  const outputChunks: Buffer[] = [];
  let renderCount = 0;
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
    outputChunks.push(Buffer.from(chunk));
  });

  const instance = render(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: toResizeSafeOutput(stdout as unknown as NodeJS.WriteStream),
    stderr: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    interactive: true,
    patchConsole: false,
    onRender: () => {
      renderCount++;
    },
  });
  await instance.waitUntilRenderFlush();

  return {
    instance,
    stdin,
    stdout,
    output: () => output,
    outputBytes: () => Buffer.concat(outputChunks),
    renderCount: () => renderCount,
    stdinReadableListenerBaseline,
    resizeListenerBaseline,
  };
}

async function send(view: RenderedView, input: string): Promise<void> {
  view.stdin.write(input);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await view.instance.waitUntilRenderFlush();
}

async function sendEscape(view: RenderedView): Promise<void> {
  view.stdin.write("\u001B");
  await delay(30);
  await view.instance.waitUntilRenderFlush();
}

async function close(view: RenderedView): Promise<void> {
  view.instance.unmount();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  view.stdin.end();
}

async function clearAndUnmount(view: RenderedView): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await view.instance.waitUntilRenderFlush();
  const exitPromise = view.instance.waitUntilExit();
  view.instance.clear();
  view.instance.unmount();
  await exitPromise;
  view.stdin.end();
}

async function resizeToHiddenFrame(view: RenderedView): Promise<void> {
  const outputOffset = view.output().length;
  const renderCountBeforeResize = view.renderCount();
  view.stdout.resize(view.stdout.columns, 1);
  await waitForCommittedFrame(view, renderCountBeforeResize, outputOffset);
  assert.equal(stripVTControlCharacters(view.output().slice(outputOffset)).trim(), "");
  await settleUpdates(view);
}

async function resizeHiddenFrame(view: RenderedView, rows: number): Promise<void> {
  const renderCountBeforeResize = view.renderCount();
  view.stdout.resize(view.stdout.columns, rows);
  await waitFor(
    () => view.renderCount() > renderCountBeforeResize,
    `Ink did not commit the hidden frame at ${rows} rows`,
  );
  await settleUpdates(view);
}

async function restoreFrame(view: RenderedView, rows: number, expected: string): Promise<string> {
  const outputOffset = view.output().length;
  view.stdout.resize(view.stdout.columns, rows);
  await waitForOutputAfter(view, outputOffset, expected);
  await settleUpdates(view);
  return view.output().slice(outputOffset);
}

async function settleUpdates(view: RenderedView): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await view.instance.waitUntilRenderFlush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await view.instance.waitUntilRenderFlush();
}

async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function assertTerminalCleanup(view: RenderedView): void {
  assert.equal(view.stdin.rawModeEnabled, false);
  assert.equal(view.stdin.listenerCount("readable"), view.stdinReadableListenerBaseline);
  assert.equal(view.stdout.listenerCount("resize"), view.resizeListenerBaseline);
  assert.ok(!view.output().includes("\u001B[2J"));
  assert.ok(!view.output().includes("\u001B[3J"));
  assert.ok(!view.output().includes("\u001B[H"));
}

async function waitForCommittedFrame(
  view: RenderedView,
  previousRenderCount: number,
  previousOutputLength: number,
): Promise<void> {
  await waitFor(
    () => view.renderCount() > previousRenderCount && view.output().length > previousOutputLength,
    "Ink did not commit and flush the resized frame",
  );
  await view.instance.waitUntilRenderFlush();
}

async function waitForOutput(view: RenderedView, expected: string): Promise<void> {
  await waitFor(
    () => view.output().includes(expected),
    `Output did not include ${expected}: ${JSON.stringify(view.output())}`,
  );
  await view.instance.waitUntilRenderFlush();
}

async function waitForOutputAfter(
  view: RenderedView,
  offset: number,
  expected: string,
): Promise<void> {
  await waitFor(
    () => view.output().slice(offset).includes(expected),
    `Output after offset did not include ${expected}: ${JSON.stringify(view.output().slice(offset))}`,
  );
}

async function waitFor(
  condition: () => boolean,
  failureMessage: string,
  timeoutMilliseconds = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(failureMessage);
    }
    await delay(10);
  }
}

function placeholderCandidate(): CommandCandidateContract {
  return {
    title: "Print value",
    command: "printf '%s' {{value}}",
    description: "Print a value",
    placeholders: [{ name: "value", description: "Value" }],
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error("deferred resolve is unavailable");
      resolvePromise(value);
    },
    reject(reason) {
      if (rejectPromise === undefined) throw new Error("deferred reject is unavailable");
      rejectPromise(reason);
    },
  };
}

function danger() {
  return { rule: "destructive-rm", reason: "recursive forced removal" };
}

function appRequest() {
  return {
    question: "print a value",
    arguments: [],
    structuredOutput: true,
    outputContract: "",
    safetyConstraints: "",
    systemPrompt: "",
    userPrompt: "",
  };
}

function candidate(title: string, command: string, description: string): CommandCandidateContract {
  return {
    title,
    command,
    description,
    placeholders: [],
  };
}
