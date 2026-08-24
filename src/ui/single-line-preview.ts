/// <reference lib="es2022.intl" />

import stringWidth from "string-width";
import { renderTerminalSafeText } from "../terminal-text.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function toSingleLinePreview(value: string): string {
  return renderTerminalSafeText(value);
}

export function toTailPreview(value: string, maxColumns: number): string {
  if (maxColumns <= 0) {
    return "";
  }

  const preview = toSingleLinePreview(value);
  const graphemes = Array.from(graphemeSegmenter.segment(preview), ({ segment }) => segment);
  let usedColumns = 0;
  let startIndex = graphemes.length;

  while (startIndex > 0) {
    const grapheme = graphemes[startIndex - 1];
    const graphemeColumns = stringWidth(grapheme);
    if (usedColumns + graphemeColumns > maxColumns) {
      break;
    }

    usedColumns += graphemeColumns;
    startIndex--;
  }

  return graphemes.slice(startIndex).join("");
}
