export function hasUnsafeTerminalControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (isUnsafeTerminalControlCodeUnit(value.charCodeAt(index))) {
      return true;
    }
  }

  return false;
}

export function renderTerminalSafeText(value: string): string {
  let rendered = "";

  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit === 0x0d) {
      rendered += "␍";
    } else if (codeUnit === 0x0a) {
      rendered += "␊";
    } else if (isUnsafeTerminalControlCodeUnit(codeUnit)) {
      rendered += "�";
    } else {
      rendered += value[index];
    }
  }

  return rendered;
}

function isUnsafeTerminalControlCodeUnit(codeUnit: number): boolean {
  return (
    codeUnit <= 0x09 ||
    (codeUnit >= 0x0b && codeUnit <= 0x0c) ||
    (codeUnit >= 0x0e && codeUnit <= 0x1f) ||
    (codeUnit >= 0x7f && codeUnit <= 0x9f)
  );
}
