export function hasUnsafeTerminalControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (
      codeUnit <= 0x09 ||
      (codeUnit >= 0x0b && codeUnit <= 0x0c) ||
      (codeUnit >= 0x0e && codeUnit <= 0x1f) ||
      (codeUnit >= 0x7f && codeUnit <= 0x9f)
    ) {
      return true;
    }
  }

  return false;
}

export function renderLineBreaksAsVisibleMarkers(value: string): string {
  return value.replace(/[\r\n]/g, (lineBreak) => (lineBreak === "\r" ? "␍" : "␊"));
}
