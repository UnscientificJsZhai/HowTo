import assert from "node:assert/strict";
import test from "node:test";

import {
  hasUnsafeTerminalControlCharacters,
  renderTerminalSafeText,
} from "../../src/terminal-text.js";

const KEY_UNSAFE_CODE_UNITS = [
  0x00, // C0 开始 (NUL)
  0x09, // C0 制表符 (TAB)
  0x0b, // C0 垂直制表 (VT)
  0x0c, // C0 换页 (FF)
  0x0e, // C0 移位 (SO)
  0x1f, // C0 单元分隔 (US)
  0x7f, // DEL
  0x80, // C1 开始 (PAD)
  0x9f, // C1 结束 (APC)
];

const KEY_SAFE_CODE_UNITS = [
  0x0a, // LF (\n)
  0x0d, // CR (\r)
  0x20, // 普通空格
  0x7e, // ~
  0xa0, // 非截断空格 (NBSP)
];

test("terminal text rules cover key forbidden C0, DEL, and C1 boundary code units", () => {
  for (const codeUnit of KEY_UNSAFE_CODE_UNITS) {
    const controlCharacter = String.fromCharCode(codeUnit);

    assert.equal(
      hasUnsafeTerminalControlCharacters(`before${controlCharacter}after`),
      true,
      `expected U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")} to be unsafe`,
    );
    assert.equal(
      renderTerminalSafeText(`before${controlCharacter}after`),
      "before\uFFFDafter",
      `expected U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")} to render safely`,
    );
  }

  for (const codeUnit of KEY_SAFE_CODE_UNITS) {
    const safeCharacter = String.fromCharCode(codeUnit);
    assert.equal(
      hasUnsafeTerminalControlCharacters(`before${safeCharacter}after`),
      false,
      `expected U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")} to be safe`,
    );
  }
});

test("terminal text rules preserve ordinary text and visibly render CR and LF", () => {
  const value = "first\r\nsecond 😀";

  assert.equal(hasUnsafeTerminalControlCharacters(value), false);
  assert.equal(renderTerminalSafeText(value), "first␍␊second 😀");
});
