import assert from "node:assert/strict";
import { test } from "node:test";
import type { Key } from "ink";
import {
  deleteLastGrapheme,
  isTextInputEvent,
  splitKeyboardInput,
} from "../../../src/ui/text-input.js";

void test("legacy 文本中的 Enter 和控制动作按顺序拆分，Shift 文本保留", () => {
  const events = splitKeyboardInput("A\tB\rC\n\u0003\u0008\u007f\u001b", key({ shift: true }));
  assert.deepEqual(
    events.map((event) => event.input),
    ["A", "", "B", "", "C", "", "c", "", "", ""],
  );
  assert.equal(events[0].key.shift, true);
  assert.equal(events[1].key.tab, true);
  assert.equal(events[3].key.return, true);
  assert.equal(events[3].key.shift, false);
  assert.equal(events[5].key.return, true);
  assert.equal(events[6].key.ctrl, true);
  assert.equal(events[7].key.backspace, true);
  assert.equal(events[8].key.backspace, true);
  assert.equal(events[9].key.escape, true);
});

void test("Kitty、已有特殊键、快捷键及未知控制字符不被重新解释", () => {
  for (const modifiers of [
    { eventType: "press" },
    { eventType: "repeat" },
    { eventType: "release" },
    { ctrl: true },
    { meta: true },
    { super: true },
    { hyper: true },
    { return: true },
    { upArrow: true },
    { backspace: true },
  ] as const) {
    const original = { input: "A\rB", key: key(modifiers) };
    assert.deepEqual(splitKeyboardInput(original.input, original.key), [original]);
  }
  const original = { input: "A\u0000\rB", key: key() };
  assert.deepEqual(splitKeyboardInput(original.input, original.key), [original]);
});

void test("删除空输入保持为空", () => {
  assert.equal(deleteLastGrapheme(""), "");
});

for (const grapheme of ["a", "中", "😀", "𠮷", "e\u0301", "👩🏽‍💻", "🇨🇳", "\r\n"]) {
  void test(`退格完整删除字素簇 ${JSON.stringify(grapheme)} 并保留前文原值`, () => {
    const prefix = "e\u0301/𠮷/";
    assert.equal(deleteLastGrapheme(grapheme), "");
    const result = deleteLastGrapheme(prefix + grapheme);
    assert.equal(result, prefix);
  });
}

void test("isTextInputEvent accepts text with non-shortcut modifiers and Kitty press states", () => {
  assert.equal(isTextInputEvent("A", key({ shift: true })), true);
  assert.equal(isTextInputEvent("!", key({ shift: true })), true);
  assert.equal(isTextInputEvent("Caps", key({ capsLock: true })), true);
  assert.equal(isTextInputEvent("7", key({ numLock: true })), true);
  assert.equal(isTextInputEvent("paste Value!", key({ eventType: "press" })), true);
  assert.equal(isTextInputEvent("many characters at once", key({ eventType: "repeat" })), true);
  assert.equal(isTextInputEvent("pasted\r\ntext", key()), true);
});

void test("isTextInputEvent rejects a whole text chunk containing any forbidden control", () => {
  for (const control of ["\u0000", "\u001b", "\u007f", "\u0085", "\u009b"]) {
    const input = `accepted-prefix${control}accepted-suffix`;
    assert.equal(
      isTextInputEvent(input, key()),
      false,
      `expected control character to reject chunk`,
    );
  }
});

void test("isTextInputEvent rejects empty, shortcut, navigation, and release events", () => {
  assert.equal(isTextInputEvent("", key()), false);

  for (const modifier of ["ctrl", "meta", "super", "hyper"] as const) {
    assert.equal(isTextInputEvent("x", key({ [modifier]: true })), false);
  }

  for (const control of [
    "upArrow",
    "downArrow",
    "leftArrow",
    "rightArrow",
    "pageUp",
    "pageDown",
    "home",
    "end",
    "tab",
    "return",
    "escape",
    "backspace",
    "delete",
  ] as const) {
    assert.equal(isTextInputEvent("x", key({ [control]: true })), false);
  }

  assert.equal(isTextInputEvent("A", key({ eventType: "release", shift: true })), false);
});

function key(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
    ...overrides,
  };
}
