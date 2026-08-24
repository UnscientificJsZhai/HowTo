import assert from "node:assert/strict";
import test from "node:test";

import {
  hasUnsafeTerminalControlCharacters,
  renderTerminalSafeText,
} from "../../src/terminal-text.js";

test("terminal text rules cover every forbidden C0, DEL, and C1 code unit", () => {
  for (const codeUnit of unsafeTerminalCodeUnits()) {
    const controlCharacter = String.fromCharCode(codeUnit);

    assert.equal(
      hasUnsafeTerminalControlCharacters(`before${controlCharacter}after`),
      true,
      `expected U+${formatCodeUnit(codeUnit)} to be unsafe`,
    );
    assert.equal(
      renderTerminalSafeText(`before${controlCharacter}after`),
      "before�after",
      `expected U+${formatCodeUnit(codeUnit)} to render safely`,
    );
  }
});

test("terminal text rules preserve ordinary text and visibly render CR and LF", () => {
  const value = "first\r\nsecond 😀";

  assert.equal(hasUnsafeTerminalControlCharacters(value), false);
  assert.equal(renderTerminalSafeText(value), "first␍␊second 😀");
});

function unsafeTerminalCodeUnits(): number[] {
  return [...range(0x00, 0x09), ...range(0x0b, 0x0c), ...range(0x0e, 0x1f), ...range(0x7f, 0x9f)];
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function formatCodeUnit(codeUnit: number): string {
  return codeUnit.toString(16).toUpperCase().padStart(4, "0");
}
