import assert from "node:assert/strict";
import { test } from "node:test";
import { toTailPreview } from "../../../src/ui/single-line-preview.js";

test("toTailPreview keeps whole grapheme clusters", () => {
  assert.equal(toTailPreview("prefix1\ufe0f\u20e3", 2), "1\ufe0f\u20e3");
  assert.equal(toTailPreview("prefix👩🏽‍💻", 2), "👩🏽‍💻");
  assert.equal(toTailPreview("prefix👍🏽", 2), "👍🏽");
  assert.equal(toTailPreview("prefixe\u0301", 1), "e\u0301");
});

test("toTailPreview converts line breaks before clipping", () => {
  const output = toTailPreview("A\r\nB", 3);

  assert.equal(output, "\u240d\u240aB");
});

test("toTailPreview stops when the next whole grapheme does not fit", () => {
  assert.equal(toTailPreview("ABEX", 2), "EX");
  assert.equal(toTailPreview("A界", 1), "");
  assert.equal(toTailPreview("anything", 0), "");
});
