/// <reference lib="es2022.intl" />

import type { Key } from "ink";
import { hasUnsafeTerminalControlCharacters } from "../terminal-text.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
