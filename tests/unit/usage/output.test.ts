import assert from "node:assert/strict";
import test from "node:test";
import { createUsageLookupResult } from "../../../src/usage/runner.js";
import {
  sanitizeUsageLookupResult,
  sanitizeUsageText,
  UsageOutputCapture,
} from "../../../src/usage/output.js";

test("查询输出保留文本结构并清除跨 chunk 的终端控制与 OSC/DCS 内容", () => {
  const capture = new UsageOutputCapture();
  for (const text of [
    "head\r",
    "\n\t\u001b[",
    "31mred\u001b[0m\u001b]52;c;",
    "hidden\u0007",
    "\u001bPprivate\u001b",
    "\\tail\u0008\u007f\u009b2J\u202eend",
  ]) {
    capture.write(Buffer.from(text));
  }
  assert.deepEqual(capture.finish(), {
    text: "head\n\tredtailend",
    truncated: false,
    credentialsRedacted: false,
  });
});

test("跨 chunk、ANSI 分隔与截断边界的已知凭据全部先脱敏", () => {
  const secret = "FAKE_USAGE_SECRET_123456789";
  const capture = new UsageOutputCapture([secret]);
  capture.write(Buffer.from("a".repeat(24 * 1024 - 3) + secret.slice(0, 8)));
  capture.write(
    Buffer.from("\u001b[0m" + secret.slice(8) + "x".repeat(40 * 1024) + secret.slice(0, 10)),
  );
  capture.write(Buffer.from(secret.slice(10) + "\nend"));
  const result = capture.finish();
  assert.equal(result.credentialsRedacted, true);
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.text), 32 * 1024);
  assert.equal(result.text.startsWith("a".repeat(24 * 1024 - 3) + "[re"), true);
  assert.equal(result.text.endsWith("[redacted]\nend"), true);
  assert.equal(result.text.includes("FAKE_"), false);
  assert.equal(result.text.includes("123456789"), false);
});

test("首 24 KiB 和尾 8 KiB 保持顺序，UTF-8 截断不制造破损字符", () => {
  const ascii = new UsageOutputCapture();
  ascii.write(Buffer.from("A".repeat(24 * 1024) + "omitted".repeat(2000) + "Z".repeat(8 * 1024)));
  assert.deepEqual(ascii.finish(), {
    text: "A".repeat(24 * 1024) + "Z".repeat(8 * 1024),
    truncated: true,
    credentialsRedacted: false,
  });
  const unicode = new UsageOutputCapture();
  const data = Buffer.from("前😀".repeat(8000));
  for (let offset = 0; offset < data.length; offset += 31)
    unicode.write(data.subarray(offset, offset + 31));
  const result = unicode.finish();
  assert.equal(result.truncated, true);
  assert.equal(result.text.includes("�"), false);
  assert.ok(Buffer.byteLength(result.text) <= 32 * 1024);
});

test("短输出保持完整，多字节字符和较长凭据不会因缓冲被拆开", () => {
  const capture = new UsageOutputCapture(["😀SECRET", "OTHER_SECRET"]);
  for (const byte of Buffer.from("你好😀SECRET；再见😀!")) capture.write(Buffer.from([byte]));
  assert.deepEqual(capture.finish(), {
    text: "你好[redacted]；再见😀!",
    truncated: false,
    credentialsRedacted: true,
  });
  assert.equal(sanitizeUsageText("abc", ["abcdef"]).text, "abc");
  assert.equal(sanitizeUsageText("abcdef", ["abc", "abcdef"]).text, "[redacted]");
});

test("工具结果保留实际 argv 的 CR/LF，只对元数据凭据做字面脱敏", () => {
  const result = createUsageLookupResult({ args: ["x\r\ny", "FAKE_CREDENTIAL"] }, "success");
  result.actualCommand = { executable: "/some/tool", args: ["x\r\ny", "FAKE_CREDENTIAL"] };
  result.stdout = "output\r\nFAKE_CREDENTIAL";
  const sanitized = sanitizeUsageLookupResult(result, ["FAKE_CREDENTIAL"]);
  assert.deepEqual(sanitized.requested, { args: ["x\r\ny", "[redacted]"] });
  assert.deepEqual(sanitized.actualCommand, {
    executable: "/some/tool",
    args: ["x\r\ny", "[redacted]"],
  });
  assert.equal(sanitized.stdout, "output\n[redacted]");
  assert.equal(sanitized.credentialsRedacted, true);
});
