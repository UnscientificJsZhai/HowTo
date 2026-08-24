import { renderTerminalSafeText } from "./terminal-text.js";

const AUTHORIZATION_CREDENTIAL_PATTERN =
  /((?<![-\w])a[�␍␊]*u[�␍␊]*t[�␍␊]*h[�␍␊]*o[�␍␊]*r[�␍␊]*i[�␍␊]*z[�␍␊]*a[�␍␊]*t[�␍␊]*i[�␍␊]*o[�␍␊]*n["'\s:=�␍␊]+)([\s\S]*)$/i;
const AUTHORIZATION_ASSIGNMENT_PATTERN =
  /((?<!\w)(?:--)?[\w-]*a[�␍␊]*u[�␍␊]*t[�␍␊]*h[�␍␊]*o[�␍␊]*r[�␍␊]*i[�␍␊]*z[�␍␊]*a[�␍␊]*t[�␍␊]*i[�␍␊]*o[�␍␊]*n["'\s�␍␊]*[:=]["'\s:=�␍␊]*)([\s\S]*)$/i;
const API_KEY_CREDENTIAL_PATTERN =
  /((?<![-\w])a[�␍␊]*p[�␍␊]*i[�␍␊]*(?:[-_ ][�␍␊]*)?k[�␍␊]*e[�␍␊]*y["'\s:=�␍␊]+)([\s\S]*)$/i;
const API_KEY_ASSIGNMENT_PATTERN =
  /((?<!\w)(?:--)?[\w-]*a[�␍␊]*p[�␍␊]*i[�␍␊]*(?:[-_ ][�␍␊]*)?k[�␍␊]*e[�␍␊]*y["'\s�␍␊]*[:=]["'\s:=�␍␊]*)([\s\S]*)$/i;
const BEARER_CREDENTIAL_PATTERN =
  /((?<![-\w])b[�␍␊]*e[�␍␊]*a[�␍␊]*r[�␍␊]*e[�␍␊]*r[\s�␍␊]+)([\s\S]*)$/i;
const URL_PATTERN = /(?<![-\w])h[�␍␊]*t[�␍␊]*t[�␍␊]*p[�␍␊]*s?[�␍␊]*:[�␍␊]*\/[�␍␊]*\/([\s\S]*)$/i;

export function sanitizeUserVisibleErrorMessage(message: string): string {
  const terminalSafe = renderTerminalSafeText(message);
  const singleLine = terminalSafe.replace(/\s+/g, " ").trim();
  const redacted = singleLine
    .replace(URL_PATTERN, "[redacted URL]")
    .replace(AUTHORIZATION_ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(API_KEY_ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(AUTHORIZATION_CREDENTIAL_PATTERN, "$1[redacted]")
    .replace(API_KEY_CREDENTIAL_PATTERN, "$1[redacted]")
    .replace(BEARER_CREDENTIAL_PATTERN, "Bearer [redacted]");

  return redacted.length > 220 ? `${redacted.slice(0, 217)}...` : redacted;
}
