import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import React from "react";
import type { CommandCandidateContract } from "../../../src/ai/types.js";
import { importWithoutColor } from "./import-without-color.js";

const uiModules = importWithoutColor(async () => {
  const [{ render }, { ResolvePlaceholdersView }, { ConfirmView }] = await Promise.all([
    import("ink"),
    import("../../../src/ui/ResolvePlaceholdersView.js"),
    import("../../../src/ui/ConfirmView.js"),
  ]);

  return { render, ResolvePlaceholdersView, ConfirmView };
});

void test("ResolvePlaceholdersView retains typed uppercase input before resolving", async (t) => {
  let resolvedCommand: string | undefined;
  const { ResolvePlaceholdersView } = await uiModules;
  const view = await renderView(
    <ResolvePlaceholdersView
      candidate={placeholderCandidate()}
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
  );
  t.after(() => close(ctrlCView));
  await send(ctrlCView, "\u0003");

  assert.equal(safeConfirmations, 1);
  assert.equal(cancellations, 3);
});

class FakeTty extends PassThrough {
  public readonly isTTY = true;
  public columns = 120;
  public rows = 40;

  public setRawMode(): this {
    return this;
  }

  public ref(): this {
    return this;
  }

  public unref(): this {
    return this;
  }
}

interface RenderedView {
  instance: Awaited<typeof uiModules>["render"] extends (...args: never[]) => infer Instance
    ? Instance
    : never;
  stdin: FakeTty;
  output: () => string;
}

async function renderView(element: React.ReactNode): Promise<RenderedView> {
  const { render } = await uiModules;
  const stdin = new FakeTty();
  const stdout = new FakeTty();
  let output = "";
  stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const instance = render(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    interactive: true,
    patchConsole: false,
  });
  await instance.waitUntilRenderFlush();

  return { instance, stdin, output: () => output };
}

async function send(view: RenderedView, input: string): Promise<void> {
  view.stdin.write(input);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function sendEscape(view: RenderedView): Promise<void> {
  view.stdin.write("\u001B");
  await delay(30);
}

async function close(view: RenderedView): Promise<void> {
  view.instance.unmount();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  view.stdin.end();
}

function placeholderCandidate(): CommandCandidateContract {
  return {
    title: "Print value",
    command: "printf '%s' {{value}}",
    description: "Print a value",
    placeholders: [{ name: "value", description: "Value" }],
  };
}

function danger() {
  return { rule: "destructive-rm", reason: "recursive forced removal" };
}
