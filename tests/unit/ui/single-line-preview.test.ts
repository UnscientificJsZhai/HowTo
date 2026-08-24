import assert from "node:assert/strict";
import { test } from "node:test";
import { toSingleLinePreview, toTailPreview } from "../../../src/ui/single-line-preview.js";

test("toSingleLinePreview renders CR and LF as visible markers", () => {
  assert.equal(toSingleLinePreview("first\r\nsecond\rthird\nfourth"), "first␍␊second␍third␊fourth");
});

test("toSingleLinePreview preserves text without line breaks", () => {
  assert.equal(toSingleLinePreview("printf '%s' value"), "printf '%s' value");
});

test("toSingleLinePreview replaces non-line-break terminal controls", () => {
  assert.equal(toSingleLinePreview("left\b\u001B[2J\u009Bright"), "left��[2J�right");
});

test("toTailPreview keeps whole grapheme clusters", () => {
  assert.equal(toTailPreview("prefix1️⃣", 2), "1️⃣");
  assert.equal(toTailPreview("prefix👩🏽‍💻", 2), "👩🏽‍💻");
  assert.equal(toTailPreview("prefix👍🏽", 2), "👍🏽");
  assert.equal(toTailPreview("prefixe\u0301", 1), "e\u0301");
});

test("toTailPreview converts line breaks before clipping", () => {
  const output = toTailPreview("A\r\nB", 3);

  assert.equal(output, "␍␊B");
  assert.ok(!output.includes("\r"));
  assert.ok(!output.includes("\n"));
});

test("toTailPreview stops when the next whole grapheme does not fit", () => {
  assert.equal(toTailPreview("ABEX", 2), "EX");
  assert.equal(toTailPreview("A界", 1), "");
  assert.equal(toTailPreview("anything", 0), "");
});
