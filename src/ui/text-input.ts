/// <reference lib="es2022.intl" />

import type { Key } from "ink";
import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// eslint-disable-next-line no-control-regex -- 显式识别传统终端协议的按键控制字节。
const LEGACY_CONTROL_PATTERN = /([\r\n\t\u0003\u0008\u001b\u007f])/;
const LEGACY_CONTROL_KEYS: ReadonlyMap<string, { input: string; key: Partial<Key> }> = new Map([
  ["\r", { input: "", key: { return: true } }],
  ["\n", { input: "", key: { return: true } }],
  ["\t", { input: "", key: { tab: true } }],
  ["\u0003", { input: "c", key: { ctrl: true } }],
  ["\u0008", { input: "", key: { backspace: true } }],
  ["\u007f", { input: "", key: { backspace: true } }],
  ["\u001b", { input: "", key: { escape: true } }],
]);

export function splitKeyboardInput(input: string, key: Key): Array<{ input: string; key: Key }> {
  const parts = input.split(LEGACY_CONTROL_PATTERN).filter((part) => part !== "");
  const text = parts.map((part) => (LEGACY_CONTROL_KEYS.has(part) ? " " : part)).join("");
  // Kitty 的文本码点已有事件边界；未知控制字符和快捷键继续交给原有规则整块处理。
  if (key.eventType !== undefined || !isTextInputEvent(text, key)) return [{ input, key }];

  return parts.map((part) => {
    const control = LEGACY_CONTROL_KEYS.get(part);
    return control === undefined
      ? { input: part, key }
      : { input: control.input, key: { ...key, shift: false, ...control.key } };
  });
}

export function deleteLastGrapheme(value: string): string {
  const lastGrapheme = graphemeSegmenter.segment(value).containing(value.length - 1);
  return lastGrapheme === undefined ? "" : value.slice(0, lastGrapheme.index);
}

export function isTextInputEvent(input: string, key: Key): boolean {
  return (
    input.length > 0 &&
    !hasUnsafeTerminalControlCharacters(input) &&
    key.eventType !== "release" &&
    !key.ctrl &&
    !key.meta &&
    !key.super &&
    !key.hyper &&
    !key.upArrow &&
    !key.downArrow &&
    !key.leftArrow &&
    !key.rightArrow &&
    !key.pageUp &&
    !key.pageDown &&
    !key.home &&
    !key.end &&
    !key.tab &&
    !key.return &&
    !key.escape &&
    !key.backspace &&
    !key.delete
  );
}
