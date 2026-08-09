import assert from "node:assert/strict";
import { test } from "node:test";
import type { Key } from "ink";
import { isTextInputEvent } from "../../../src/ui/text-input.js";

void test("isTextInputEvent accepts text with non-shortcut modifiers and Kitty press states", () => {
  assert.equal(isTextInputEvent("A", key({ shift: true })), true);
  assert.equal(isTextInputEvent("!", key({ shift: true })), true);
  assert.equal(isTextInputEvent("Caps", key({ capsLock: true })), true);
  assert.equal(isTextInputEvent("7", key({ numLock: true })), true);
  assert.equal(isTextInputEvent("paste Value!", key({ eventType: "press" })), true);
  assert.equal(isTextInputEvent("many characters at once", key({ eventType: "repeat" })), true);
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
