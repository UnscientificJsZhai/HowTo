/// <reference lib="es2022.intl" />

import stringWidth from "string-width";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

export function toSingleLinePreview(value: string): string {
  return value.replace(/\r/g, "␍").replace(/\n/g, "␊");
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
