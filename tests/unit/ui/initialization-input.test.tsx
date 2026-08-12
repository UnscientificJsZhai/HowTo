import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import React from "react";
import type { AppConfig } from "../../../src/config.js";
import type { InitializationValues } from "../../../src/init/index.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [
    { render },
    { InitializationApp },
    { initializeConfig },
    { InteractionCancelledError },
    { toResizeSafeOutput, usePhysicalStdoutRows },
  ] = await Promise.all([
    import("ink"),
    import("../../../src/init/InitializationApp.js"),
    import("../../../src/init/index.js"),
    import("../../../src/ui/tty.js"),
    import("../../../src/ui/resize-safe-output.js"),
  ]);

  return {
    render,
    InitializationApp,
    initializeConfig,
    InteractionCancelledError,
    toResizeSafeOutput,
    usePhysicalStdoutRows,
  };
});

void test("initialization keeps its initial frame below a four-row terminal", async (t) => {
  const view = await renderInitialization({ columns: 40, rows: 4 });
  t.after(() => close(view));

  const visibleOutput = stripVTControlCharacters(view.output()).trimEnd();
  assert.equal(visibleOutput, "? Choose provider\n1 openai 2 gemini\nUD Enter 1/2 Esc");
  assertNoFullscreenClear(view.output());
});

void test("initialization keeps rich provider and OpenAI field guidance at forty columns", async (t) => {
  const view = await renderInitialization({ columns: 40, rows: 24 });
  t.after(() => close(view));

  let frame = normalizeWhitespace(stripVTControlCharacters(view.output()));
  assert.ok(frame.includes("howto needs an AI provider before it can call AI."));
  assert.ok(frame.includes("? Choose AI provider"));
  assert.ok(frame.includes("1. openai"));
  assert.ok(frame.includes("2. gemini"));
  assert.ok(
    frame.includes("Use Up/Down or 1/2 to choose, Enter to continue, Esc or Ctrl+C to cancel."),
  );

  const outputOffset = view.output().length;
  await send(view, "1");
  frame = normalizeWhitespace(stripVTControlCharacters(view.output().slice(outputOffset)));
  assert.ok(frame.includes("? Configure openai"));
  assert.ok(frame.includes("> Key:"));
  assert.ok(frame.includes("Model:"));
  assert.ok(frame.includes("URL:"));
  assert.ok(frame.includes("Optional; empty allowed."));
  assert.ok(frame.includes("Press Enter for next value, Esc to go back, Ctrl+C to cancel."));
  assertNoFullscreenClear(view.output());
});

void test("initialization keeps provider and input priorities visible at five rows", async () => {
  for (const columns of [20, 40]) {
    const view = await renderInitialization({ columns, rows: 5 });

    try {
      let frameLines = renderedUpdateLines(view, 0).slice(-4);
      assert.equal(frameLines.length, 4);
      assert.ok(frameLines[0]?.startsWith("howto needs"));
      assert.equal(frameLines[1], "? Choose provider");
      assert.equal(frameLines[2], "1 openai 2 gemini");
      assert.equal(frameLines[3], "UD Enter 1/2 Esc");

      let outputOffset = view.output().length;
      await send(view, "\r");
      assert.ok(!renderedUpdate(view, outputOffset).includes("Configure"));

      outputOffset = view.output().length;
      await send(view, "1");
      frameLines = renderedUpdateLines(view, outputOffset).slice(-4);
      assert.equal(frameLines[1], "Key: <empty>");
      assert.ok(frameLines[2]?.startsWith("Optional; empty"));
      if (columns === 40) {
        assert.equal(frameLines[2], "Optional; empty allowed.");
      }
      assert.equal(frameLines[3], "Ent next Esc back ^C");
      assert.equal(frameLines[0], "? Configure openai");

      await sendEscape(view);
      outputOffset = view.output().length;
      await send(view, "2");
      frameLines = renderedUpdateLines(view, outputOffset).slice(-4);
      assert.deepEqual(frameLines, [
        "? Configure gemini",
        "Key: <required>",
        "Required.",
        "Ent next Esc back ^C",
      ]);

      outputOffset = view.output().length;
      await send(view, "\r");
      frameLines = renderedUpdateLines(view, outputOffset).slice(-4);
      assert.deepEqual(frameLines, [
        "! Key required",
        "Key: <required>",
        "Required.",
        "Ent next Esc back ^C",
      ]);
      assertNoFullscreenClear(view.output());
      await clearAndUnmount(view);
    } finally {
      await close(view);
    }
  }
});

void test("initialization switches from intermediate to rich layout at the narrow boundary", async () => {
  const view = await renderInitialization({ columns: 20, rows: 15 });

  try {
    let frameLines = renderedUpdateLines(view, 0);
    assert.equal(frameLines.length, 4);
    assert.equal(frameLines.at(-1), "UD Enter 1/2 Esc");
    assert.ok(!renderedUpdate(view, 0).includes("1. openai"));

    const outputOffset = view.output().length;
    await resizeAndWait(view, 16);
    const richProvider = normalizeWhitespace(renderedUpdate(view, outputOffset));
    frameLines = renderedUpdateLines(view, outputOffset);
    assert.ok(frameLines.length <= 15);
    assert.ok(richProvider.includes("howto needs an AI provider before it can call AI."));
    assert.ok(richProvider.includes("? Choose AI provider"));
    assert.ok(richProvider.includes("1. openai"));
    assert.ok(richProvider.includes("2. gemini"));
    assert.ok(
      richProvider.includes(
        "Use Up/Down or 1/2 to choose, Enter to continue, Esc or Ctrl+C to cancel.",
      ),
    );

    const inputOffset = view.output().length;
    await send(view, "1");
    const richInput = normalizeWhitespace(renderedUpdate(view, inputOffset));
    frameLines = renderedUpdateLines(view, inputOffset);
    assert.ok(frameLines.length <= 15);
    assert.ok(richInput.includes("? Configure openai"));
    assert.ok(richInput.includes("> Key:"));
    assert.ok(richInput.includes("Model:"));
    assert.ok(richInput.includes("URL:"));
    assert.ok(richInput.includes("Press Enter for next value, Esc to go back, Ctrl+C to cancel."));
    assertNoFullscreenClear(view.output());
    await clearAndUnmount(view);
  } finally {
    await close(view);
  }
});

void test("initialization preserves provider and field state across compact intermediate and rich layouts", async () => {
  for (const columns of [20, 40]) {
    let submittedValues: InitializationValues | undefined;
    const view = await renderInitialization({ columns, rows: 4 }, (values) => {
      submittedValues = values;
      return Promise.resolve(testConfig());
    });

    try {
      await send(view, "\u001B[B");
      for (const rows of [5, 24, 5, 4]) {
        const outputOffset = view.output().length;
        await resizeAndWait(view, rows);
        const update = normalizeWhitespace(renderedUpdate(view, outputOffset));
        if (rows === 24) {
          assert.ok(update.includes("1. openai"));
          assert.ok(update.includes("Use Up/Down or 1/2 to choose"));
        } else {
          assert.ok(update.includes("> openai 2 gemini"));
          assert.ok(update.includes("UD Enter 1/2 Esc"));
        }
      }

      await resizeAndWait(view, 5);
      await send(view, "\r");
      await send(view, "\u001B[200~Ab\u001B[201~");
      for (const rows of [4, 5, 24, 5, 4]) {
        const outputOffset = view.output().length;
        await resizeAndWait(view, rows);
        const update = normalizeWhitespace(renderedUpdate(view, outputOffset));
        assert.ok(update.includes("Key: Ab"));
        assert.ok(
          update.includes(
            rows === 24
              ? "Press Enter for next value, Esc to go back, Ctrl+C to cancel."
              : "Ent next Esc back ^C",
          ),
        );
      }

      await send(view, "\r");
      await send(view, "\r");
      await send(view, "\r");
      await waitFor(() => submittedValues !== undefined, "Initialization did not submit values");
      assert.deepEqual(submittedValues, {
        provider: "openai",
        apiKey: "Ab",
        model: "gpt-5.4-mini",
        openaiBaseUrl: undefined,
      });
      assertNoFullscreenClear(view.output());
      await clearAndUnmount(view);
    } finally {
      await close(view);
    }
  }
});

void test("initialization keeps provider selection and the current field visible at four rows", async (t) => {
  const view = await renderInitialization({ columns: 40, rows: 4 });
  t.after(() => close(view));

  let outputOffset = view.output().length;
  await send(view, "\r");
  let updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(!updateOutput.includes("Configure"));

  outputOffset = view.output().length;
  await send(view, "\u001B[B");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("> openai 2 gemini"));
  assert.ok(updateOutput.includes("UD Enter 1/2 Esc"));

  outputOffset = view.output().length;
  await send(view, "\u001B[B");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("1 openai > gemini"));

  outputOffset = view.output().length;
  await send(view, "\u001B[A");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("> openai 2 gemini"));

  outputOffset = view.output().length;
  await send(view, "\r");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("? Configure openai"));
  assert.ok(updateOutput.includes("Key: <empty>"));
  assert.ok(updateOutput.includes("Ent next Esc back ^C"));

  outputOffset = view.output().length;
  await send(view, "A");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("Key: A"));
  assertNoFullscreenClear(view.output());
});

void test("initialization keeps provider and field controls visible across three and two rows", async (t) => {
  let cancellations = 0;
  const view = await renderInitialization(
    { columns: 20, rows: 3 },
    () => Promise.resolve(testConfig()),
    () => {
      cancellations++;
    },
  );
  t.after(() => close(view));

  assert.equal(
    stripVTControlCharacters(view.output()).trimEnd(),
    "1 openai 2 gemini\nUD Enter 1/2 Esc",
  );

  let outputOffset = view.output().length;
  await send(view, "\u001B[B");
  let updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("> openai 2 gemini"));
  assert.ok(updateOutput.includes("UD Enter 1/2 Esc"));

  outputOffset = view.output().length;
  await send(view, "\r");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("Key: <empty>"));
  assert.ok(updateOutput.includes("Ent next Esc back ^C"));

  await sendEscape(view);
  outputOffset = view.output().length;
  await resizeAndWait(view, 2);
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("O/G:- UD Ent 1/2 Esc"));

  outputOffset = view.output().length;
  await send(view, "\u001B[B");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("O/G:O UD Ent 1/2 Esc"));

  outputOffset = view.output().length;
  await send(view, "\r");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.match(updateOutput, /^Key:-[ \t]+Ent Esc \^C$/m);

  outputOffset = view.output().length;
  await send(view, "x");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.match(updateOutput, /^Key:x[ \t]+Ent Esc \^C$/m);

  outputOffset = view.output().length;
  await send(view, "\u0003");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.equal(cancellations, 1);
  assert.ok(updateOutput.includes("Initialization"));
  assertNoFullscreenClear(view.output());
});

void test("initialization keeps rich long values visible and submits their original values", async () => {
  const apiKey = "abcdefghijklmnopqrstuvwxyz0123456789";
  const model = "自定义模型custom-model";
  let submittedValues: InitializationValues | undefined;
  const view = await renderInitialization({ columns: 20, rows: 24 }, (values) => {
    submittedValues = values;
    return new Promise<AppConfig>(() => undefined);
  });

  try {
    let outputOffset = view.output().length;
    await send(view, "1");
    const baselineLineCount = renderedUpdateLines(view, outputOffset).length;

    outputOffset = view.output().length;
    await send(view, `\u001B[200~${apiKey}\u001B[201~`);
    let frame = renderedUpdate(view, outputOffset);
    assert.ok(frame.includes("> Key: abc"));
    assert.ok(renderedUpdateLines(view, outputOffset).length <= baselineLineCount);
    assert.ok(!frame.includes("…"));

    outputOffset = view.output().length;
    await resizeAndWait(view, 3);
    frame = renderedUpdate(view, outputOffset);
    let lines = renderedUpdateLines(view, outputOffset);
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.startsWith("Key: abc"));
    assert.equal(lines[1], "Ent next Esc back ^C");
    assert.ok(!frame.includes("…"));

    outputOffset = view.output().length;
    await resizeAndWait(view, 2);
    frame = renderedUpdate(view, outputOffset);
    lines = renderedUpdateLines(view, outputOffset);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.startsWith("Key:a"));
    assert.ok(lines[0]?.endsWith(" Ent Esc ^C"));
    assert.ok(!frame.includes("…"));

    await resizeAndWait(view, 24);
    outputOffset = view.output().length;
    await send(view, "\r");
    frame = renderedUpdate(view, outputOffset);
    assert.ok(frame.includes("> Model:"));
    assert.ok(frame.includes("Default: gpt-5.4"));

    outputOffset = view.output().length;
    await send(view, `\u001B[200~${model}\u001B[201~`);
    frame = renderedUpdate(view, outputOffset);
    assert.ok(frame.includes("> Model: 自"));
    assert.ok(!frame.includes("…"));

    outputOffset = view.output().length;
    await resizeAndWait(view, 3);
    frame = renderedUpdate(view, outputOffset);
    lines = renderedUpdateLines(view, outputOffset);
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.startsWith("Model: 自"));
    assert.equal(lines[1], "Ent next Esc back ^C");
    assert.ok(!frame.includes("…"));

    outputOffset = view.output().length;
    await resizeAndWait(view, 2);
    frame = renderedUpdate(view, outputOffset);
    lines = renderedUpdateLines(view, outputOffset);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]?.startsWith("Model:自"));
    assert.ok(lines[0]?.endsWith(" Ent Esc ^C"));
    assert.ok(!frame.includes("…"));

    await resizeAndWait(view, 24);
    outputOffset = view.output().length;
    await send(view, "\r");
    frame = renderedUpdate(view, outputOffset);
    assert.ok(frame.includes("> URL:"));
    assert.ok(frame.includes("Empty uses official"));

    await send(view, "\r");
    await waitFor(
      () => submittedValues !== undefined,
      "Initialization did not submit OpenAI values",
    );
    assert.deepEqual(submittedValues, {
      provider: "openai",
      apiKey,
      model,
      openaiBaseUrl: undefined,
    });
    assertNoFullscreenClear(view.output());
  } finally {
    await close(view);
  }
});

void test("initialization prioritizes validation, values, and defaults without changing pasted input", async (t) => {
  const pastedKey = "A\r\nB";
  let submittedValues: InitializationValues | undefined;
  const view = await renderInitialization({ columns: 40, rows: 4 }, (values) => {
    submittedValues = values;
    return new Promise<AppConfig>(() => undefined);
  });
  t.after(() => close(view));

  let outputOffset = view.output().length;
  await send(view, "2");
  let updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("? Configure gemini"));
  assert.ok(updateOutput.includes("Key: <required>"));
  assert.ok(updateOutput.includes("Ent next Esc back ^C"));

  await resizeAndWait(view, 2);
  outputOffset = view.output().length;
  await send(view, "\r");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.match(updateOutput, /^!Key:req[ \t]+Ent Esc \^C$/m);

  await resizeAndWait(view, 4);

  outputOffset = view.output().length;
  await send(view, `\u001B[200~${pastedKey}\u001B[201~`);
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("Key: A␍␊B"));
  assert.ok(!updateOutput.includes("\r"));

  outputOffset = view.output().length;
  await send(view, "\r");
  updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
  assert.ok(updateOutput.includes("Model: gemini-3.1-flash-lite"));
  assert.ok(updateOutput.includes("Ent next Esc back ^C"));

  await send(view, "\r");
  await waitFor(() => submittedValues !== undefined, "Initialization did not submit Gemini values");

  assert.deepEqual(submittedValues, {
    provider: "gemini",
    apiKey: pastedKey,
    model: "gemini-3.1-flash-lite",
  });
  assertNoFullscreenClear(view.output());
});

void test("initialization clips long ASCII and CJK multiline saving errors to one row", async () => {
  const errorMessage = "a中\r\nx 长保存错误abcdefghijklmnopqrstuvwxyz";
  let rejectSubmission: ((error: Error) => void) | undefined;
  let reportedErrors = 0;
  const pendingSubmission = new Promise<AppConfig>((_resolve, reject) => {
    rejectSubmission = reject;
  });
  const view = await renderInitialization(
    { columns: 20, rows: 2 },
    () => pendingSubmission,
    () => {},
    () => {
      reportedErrors++;
    },
  );

  try {
    await send(view, "1");
    await send(view, "\r");
    await send(view, "\r");

    let outputOffset = view.output().length;
    await send(view, "\r");
    let updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
    let frame = renderedUpdate(view, outputOffset);
    assert.equal(renderedUpdateLines(view, outputOffset).length, 1);
    assert.ok(frame.startsWith("Saving howto"));
    assert.ok(updateOutput.includes("Saving howto"));
    assert.ok(!frame.includes("…"));

    outputOffset = view.output().length;
    rejectSubmission?.(new Error(errorMessage));
    await waitFor(() => reportedErrors === 1, "Initialization did not report the saving error");
    await view.instance.waitUntilRenderFlush();
    updateOutput = stripVTControlCharacters(view.output().slice(outputOffset));
    frame = renderedUpdate(view, outputOffset);
    assert.equal(renderedUpdateLines(view, outputOffset).length, 1);
    assert.ok(frame.startsWith("Error: a中␍␊x"));
    assert.ok(updateOutput.includes("a中␍␊x"));
    assert.ok(!frame.includes("…"));
    assert.ok(!updateOutput.includes("\r"));
    assertNoFullscreenClear(view.output());
  } finally {
    await close(view);
  }
});

void test("initialization resize commits stay below fullscreen and release resize listeners", async () => {
  const view = await renderInitialization({ columns: 80, rows: 24 });
  const resizeListenerBaseline = view.resizeListenerBaseline;
  assert.ok(view.stdout.listenerCount("resize") > resizeListenerBaseline);

  for (const rows of [4, 1, 0]) {
    await resizeAndWait(view, rows);
  }

  await clearAndUnmount(view);

  assertNoFullscreenClear(view.output());
  assert.equal(view.stdout.listenerCount("resize"), resizeListenerBaseline);
});

void test("initialization cleanup releases every owner and remains idempotent", async () => {
  const view = await renderInitialization({ columns: 40, rows: 4 });

  await clearAndUnmount(view);
  await clearAndUnmount(view);
});

void test("production initialization cancellation releases every terminal owner", async () => {
  const { initializeConfig, InteractionCancelledError } = await uiModules;
  const stdin = new FakeTty(40, 4);
  const stdout = new FakeTty(40, 4);
  const stdinReadableBaseline = stdin.listenerCount("readable");
  const processBeforeExitBaseline = process.listenerCount("beforeExit");
  const resizeListenerBaseline = stdout.listenerCount("resize");
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const initialization = initializeConfig({
    cliOptions: { print: false },
    env: {},
    input: stdin,
    output: stdout,
  });

  try {
    await waitFor(
      () =>
        stdin.rawModeEnabled &&
        stdin.listenerCount("readable") > stdinReadableBaseline &&
        stdout.listenerCount("resize") > resizeListenerBaseline,
      "Production initialization did not register its terminal owners",
    );

    const cancellation = assert.rejects(initialization, InteractionCancelledError);
    stdin.write("\u001B");
    await delay(30);
    await cancellation;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    assert.equal(stdin.rawModeEnabled, false);
    assert.equal(stdin.listenerCount("readable"), stdinReadableBaseline);
    assert.equal(process.listenerCount("beforeExit"), processBeforeExitBaseline);
    assert.equal(stdout.listenerCount("resize"), resizeListenerBaseline);
    assertNoFullscreenClear(output);
  } finally {
    stdin.end();
    stdout.end();
  }
});

void test("initialization renders no visible frame when the terminal initially reports zero rows", async () => {
  const view = await renderInitialization({ columns: 40, rows: 0 });

  await clearAndUnmount(view);

  assert.equal(stripVTControlCharacters(view.output()).trim(), "");
  assertNoFullscreenClear(view.output());
  assert.equal(view.stdout.listenerCount("resize"), view.resizeListenerBaseline);
});

void test("initialization preserves provider and field input across one-row and hidden frames", async (t) => {
  let submittedValues: InitializationValues | undefined;
  let cancellations = 0;
  const view = await renderInitialization(
    { columns: 40, rows: 4 },
    (values) => {
      submittedValues = values;
      return Promise.resolve(testConfig());
    },
    () => {
      cancellations++;
    },
  );
  t.after(() => close(view));

  await send(view, "\u001B[B");
  await resizeAndWait(view, 2);
  await resizeAndWait(view, 4);
  await send(view, "\r");

  for (const character of "abc") {
    await send(view, character);
  }
  await resizeAndWait(view, 2);
  await resizeAndWait(view, 4);

  const outputLengthBeforeHiddenFrame = view.output().length;
  await resizeAndWait(view, 1);
  assert.equal(
    stripVTControlCharacters(view.output().slice(outputLengthBeforeHiddenFrame)).trim(),
    "",
  );
  await send(view, "\u0003");
  await send(view, "IGNORED");
  await resizeAndWait(view, 4);
  await send(view, "d");
  await send(view, "\r");
  await send(view, "\r");
  await send(view, "\r");
  await waitFor(() => submittedValues !== undefined, "Initialization did not submit values");

  assert.deepEqual(submittedValues, {
    provider: "openai",
    apiKey: "abcd",
    model: "gpt-5.4-mini",
    openaiBaseUrl: undefined,
  });
  assert.equal(cancellations, 0);
});

void test("initialization consumes hidden saving input without cancelling or replaying it", async (t) => {
  let rejectSubmission: ((error: Error) => void) | undefined;
  let cancellations = 0;
  let errors = 0;
  const pendingSubmission = new Promise<AppConfig>((_resolve, reject) => {
    rejectSubmission = reject;
  });
  const view = await renderInitialization(
    { columns: 40, rows: 4 },
    () => pendingSubmission,
    () => {
      cancellations++;
    },
    () => {
      errors++;
    },
  );
  t.after(() => close(view));

  await send(view, "1");
  await send(view, "a");
  await send(view, "\r");
  await send(view, "\r");
  await send(view, "\r");
  await resizeAndWait(view, 1);
  await send(view, "\u0003");
  await send(view, "IGNORED");

  assert.equal(view.stdin.readableLength, 0);
  rejectSubmission?.(new Error("saving failed"));
  await waitFor(() => errors === 1, "Initialization did not report the saving error");
  await resizeAndWait(view, 4);

  assert.equal(cancellations, 0);
  assert.equal(view.stdin.readableLength, 0);
  assert.match(stripVTControlCharacters(view.output()), /Error: saving failed/);
});

class FakeTty extends PassThrough {
  public readonly isTTY = true;
  public rawModeEnabled = false;

  public constructor(
    public columns: number,
    public rows: number,
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

interface RenderedInitialization {
  instance: ReturnType<Awaited<typeof uiModules>["render"]>;
  stdin: FakeTty;
  stdout: FakeTty;
  output: () => string;
  observedRows: () => number | undefined;
  stdinReadableBaseline: number;
  processBeforeExitBaseline: number;
  resizeListenerBaseline: number;
  closed: boolean;
}

interface Viewport {
  columns: number;
  rows: number;
}

async function renderInitialization(
  viewport: Viewport,
  onSubmit: (values: InitializationValues) => Promise<AppConfig> = () =>
    Promise.resolve(testConfig()),
  onCancel: () => void = () => {},
  onError: (error: Error) => void = () => {},
): Promise<RenderedInitialization> {
  const { render, InitializationApp, toResizeSafeOutput, usePhysicalStdoutRows } = await uiModules;
  const stdin = new FakeTty(viewport.columns, viewport.rows);
  const stdout = new FakeTty(viewport.columns, viewport.rows);
  const stdinReadableBaseline = stdin.listenerCount("readable");
  const processBeforeExitBaseline = process.listenerCount("beforeExit");
  const resizeListenerBaseline = stdout.listenerCount("resize");
  let output = "";
  let observedRows: number | undefined;
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const PhysicalRowsObserver = () => {
    const rows = usePhysicalStdoutRows();
    React.useEffect(() => {
      observedRows = rows;
    }, [rows]);
    return null;
  };

  const instance = render(
    <>
      <InitializationApp
        onSubmit={onSubmit}
        onComplete={() => {}}
        onCancel={onCancel}
        onError={onError}
      />
      <PhysicalRowsObserver />
    </>,
    {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: toResizeSafeOutput(stdout as unknown as NodeJS.WriteStream),
      stderr: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      interactive: true,
      kittyKeyboard: { mode: "disabled" },
      maxFps: 1000,
      patchConsole: false,
    },
  );
  await instance.waitUntilRenderFlush();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await waitFor(
    () => observedRows === viewport.rows,
    `Physical rows observer did not report ${viewport.rows}`,
  );
  assert.equal(stdin.rawModeEnabled, true);
  assert.ok(stdin.listenerCount("readable") > stdinReadableBaseline);
  assert.ok(stdout.listenerCount("resize") > resizeListenerBaseline);

  return {
    instance,
    stdin,
    stdout,
    output: () => output,
    observedRows: () => observedRows,
    stdinReadableBaseline,
    processBeforeExitBaseline,
    resizeListenerBaseline,
    closed: false,
  };
}

async function send(view: RenderedInitialization, input: string): Promise<void> {
  view.stdin.write(input);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  await view.instance.waitUntilRenderFlush();
}

async function sendEscape(view: RenderedInitialization): Promise<void> {
  view.stdin.write("\u001B");
  await delay(30);
  await view.instance.waitUntilRenderFlush();
}

async function resizeAndWait(view: RenderedInitialization, rows: number): Promise<void> {
  view.stdout.resize(view.stdout.columns, rows);
  await waitFor(
    () => view.observedRows() === rows,
    `Physical rows observer did not report ${rows}`,
  );
  await view.instance.waitUntilRenderFlush();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function clearAndUnmount(view: RenderedInitialization): Promise<void> {
  if (view.closed) {
    return;
  }

  const exitPromise = view.instance.waitUntilExit();
  view.instance.clear();
  view.instance.unmount();
  await exitPromise;
  view.stdin.end();
  view.closed = true;
  assert.equal(view.stdin.rawModeEnabled, false);
  assert.equal(view.stdin.listenerCount("readable"), view.stdinReadableBaseline);
  assert.equal(process.listenerCount("beforeExit"), view.processBeforeExitBaseline);
  assert.equal(view.stdout.listenerCount("resize"), view.resizeListenerBaseline);
  assertNoFullscreenClear(view.output());
}

async function close(view: RenderedInitialization): Promise<void> {
  await clearAndUnmount(view);
}

function renderedUpdate(view: RenderedInitialization, outputOffset: number): string {
  return stripVTControlCharacters(view.output().slice(outputOffset)).trimEnd();
}

function renderedUpdateLines(view: RenderedInitialization, outputOffset: number): string[] {
  const frame = renderedUpdate(view, outputOffset);
  return frame === "" ? [] : frame.split("\n");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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

function assertNoFullscreenClear(output: string): void {
  assert.ok(!output.includes("\u001B[2J"));
  assert.ok(!output.includes("\u001B[3J"));
  assert.ok(!output.includes("\u001B[H"));
}

function testConfig(): AppConfig {
  return {
    aiProvider: "openai",
    gemini: { model: "gemini-3.1-flash-lite" },
    openai: { apiKey: "", model: "gpt-5.4-mini" },
    structuredOutput: true,
  };
}
