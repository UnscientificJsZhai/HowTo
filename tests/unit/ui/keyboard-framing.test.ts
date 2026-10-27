import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyboardFramingFilter } from "../../../src/ui/keyboard-framing.js";
import { PASTE_START, PASTE_END } from "../../../src/ui/paste-framing.js";

void test("待定 Esc 或 CSI 不改变紧随其后的完整粘贴通道", () => {
  const paste = PASTE_START + "first\r\nsecond" + PASTE_END;
  for (const prefix of ["\u001b", "\u001b\u001b", "\u001b[13;"]) {
    const filter = new KeyboardFramingFilter();
    filter.setActive(true);
    assert.equal(filter.push(prefix), "");
    assert.equal(
      filter.push(paste),
      (prefix.includes("[") ? "" : "\u001b[27u".repeat(prefix.length)) + paste,
    );
  }
});

void test("连续三个 Esc 都完整交付，末尾前缀保留在会话层直到刷新", () => {
  const filter = new KeyboardFramingFilter();
  filter.setActive(true);
  assert.equal(filter.push("\u001b\u001b\u001b"), "\u001b[27u".repeat(2));
  assert.equal(filter.flushEscape(), "\u001b[27u");
  assert.doesNotThrow(() => filter.assertComplete());
});

void test("CSI、SS3、双 Esc 和 Unicode 快捷键的任意分片保持完整事件", () => {
  for (const sequence of [
    "\u001b[B",
    "\u001b[13;1:3u",
    "\u001bOM",
    "\u001b\u001b[13u",
    "\u001b[[5~",
    "\u001b😀",
  ]) {
    const characters = [...sequence];
    for (let split = 1; split < characters.length; split++) {
      const filter = new KeyboardFramingFilter();
      filter.setActive(true);
      const first = filter.push(characters.slice(0, split).join(""));
      assert.equal(first, "");
      assert.equal(filter.push(characters.slice(split).join("")), sequence);
    }
  }
});

void test("按键前缀跨输入边界整体失效，之后的新按键仍保留", () => {
  for (const sequence of ["\u001b[13u", "\u001bOM", "\u001b\u001b[13u"]) {
    for (let split = 1; split < sequence.length; split++) {
      const filter = new KeyboardFramingFilter();
      filter.setActive(true);
      assert.equal(filter.push(sequence.slice(0, split)), "");
      filter.setActive(false);
      filter.setActive(true);
      assert.equal(filter.push(sequence.slice(split) + "fresh\r"), "fresh\r");
    }
  }
});

void test("未完成、无效及超长按键序列不能交接或无限缓存", () => {
  const filter = new KeyboardFramingFilter();
  filter.setActive(true);
  filter.push("\u001b[13;");
  assert.throws(() => filter.assertComplete(), /尚未结束/);
  assert.throws(() => filter.push("\r"), /序列无效/);
  filter.clear();
  assert.throws(() => filter.push("\u001b[" + "1".repeat(4096)), /序列过长/);
});
