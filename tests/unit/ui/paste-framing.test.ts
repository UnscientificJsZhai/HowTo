import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PASTE_END,
  PASTE_START,
  PasteFramingFilter,
  PasteStartObserver,
} from "../../../src/ui/paste-framing.js";

void test("开始标记的每个分割位置都撤销权限，包括逐字节输入", () => {
  for (let split = 0; split <= PASTE_START.length; split++) {
    const observer = new PasteStartObserver();
    const found = observer.observe(Buffer.from(PASTE_START.slice(0, split)));
    assert.equal(found || observer.observe(Buffer.from(PASTE_START.slice(split))), true);
  }
  const observer = new PasteStartObserver();
  for (const [index, byte] of Buffer.from(PASTE_START).entries()) {
    assert.equal(observer.observe(Buffer.from([byte])), index === 5);
  }
});

void test("完整安全粘贴对全部分片保持原始顺序及 CR LF Unicode", () => {
  const payload = "中文😀\r\n值";
  const input = `a${PASTE_START}${payload}${PASTE_END}${PASTE_START}-后${PASTE_END}\r`;
  for (let split = 0; split <= input.length; split++) {
    const filter = new PasteFramingFilter();
    filter.setActive(true);
    assert.equal(filter.push(input.slice(0, split)) + filter.push(input.slice(split)), input);
  }
});

void test("含控制字符的已识别粘贴整块丢弃，不残留安全文字或动作", () => {
  for (const control of ["\u001b[2J", "\u0003", "\u007f", "\u009b", "\u0085"]) {
    const filter = new PasteFramingFilter();
    filter.setActive(true);
    assert.equal(filter.push(`kept${PASTE_START}SAFE${control}END${PASTE_END}later`), "keptlater");
  }
});

void test("任何一个原始位置跨隐藏都会丢弃整块粘贴，下一块可见粘贴仍可输入", () => {
  const input = `${PASTE_START}HIDDEN${PASTE_END}`;
  for (let split = 1; split < input.length; split++) {
    const filter = new PasteFramingFilter();
    filter.setActive(true);
    assert.equal(filter.push(input.slice(0, split)), "");
    filter.setActive(false);
    filter.setActive(true);
    assert.equal(filter.push(input.slice(split)), "", `跨隐藏位置 ${split}`);
    assert.equal(filter.push(`${PASTE_START}fresh${PASTE_END}`), `${PASTE_START}fresh${PASTE_END}`);
  }
  for (const visibleStart of [true, false]) {
    const filter = new PasteFramingFilter();
    filter.setActive(visibleStart);
    filter.push(`${PASTE_START}hidden`);
    filter.setActive(!visibleStart);
    assert.equal(filter.push(PASTE_END), "");
  }
});

void test("键盘前缀刷新保留开始标记匹配，不能把后续 payload 当键盘", () => {
  for (let split = 1; split < PASTE_START.length; split++) {
    const observer = new PasteStartObserver();
    const filter = new PasteFramingFilter();
    filter.setActive(true);
    const first = PASTE_START.slice(0, split);
    observer.observe(Buffer.from(first));
    assert.equal(filter.push(first), "");
    assert.equal(filter.flushKeyboardPrefix(), first);
    const rest = `${PASTE_START.slice(split)}EXECUTE${PASTE_END}`;
    assert.equal(observer.observe(Buffer.from(rest)), true);
    assert.equal(filter.push(rest), "");
    assert.equal(filter.push("fresh"), "fresh");
  }
});
