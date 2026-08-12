import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { test } from "node:test";
import {
  normalizePhysicalRows,
  toResizeSafeOutput,
  unwrapResizeSafeOutput,
} from "../../../src/ui/resize-safe-output.js";

void test("physical stdout rows are normalized without treating finite zero as missing", () => {
  const cases: ReadonlyArray<readonly [unknown, number]> = [
    [undefined, 24],
    [Number.NaN, 24],
    [Number.POSITIVE_INFINITY, 24],
    [Number.NEGATIVE_INFINITY, 24],
    [0, 0],
    [-1, 0],
    [-1.5, 0],
    [3.9, 3],
    [24, 24],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizePhysicalRows(input), expected, `input: ${String(input)}`);
  }
});

void test("resize-safe stdout wrapping is idempotent and unwraps to the physical stream", () => {
  const physical = new TestOutput();
  const output = physical as unknown as NodeJS.WriteStream;

  const proxy = toResizeSafeOutput(output);

  assert.equal(toResizeSafeOutput(output), proxy);
  assert.equal(toResizeSafeOutput(proxy), proxy);
  assert.equal(unwrapResizeSafeOutput(proxy), output);
  assert.equal(unwrapResizeSafeOutput(output), output);
});

void test("resize-safe stdout exposes safe rows and current physical stream properties", () => {
  const physical = new TestOutput();
  const proxy = toResizeSafeOutput(physical as unknown as NodeJS.WriteStream);

  assert.equal(proxy.rows, Number.MAX_SAFE_INTEGER);
  assert.equal(proxy.columns, 80);
  assert.equal(proxy.isTTY, true);

  physical.columns = 120;
  assert.equal(proxy.columns, 120);
});

void test("resize-safe stdout preserves constructor semantics", () => {
  const physical = new TestOutput();
  const proxy = toResizeSafeOutput(physical as unknown as NodeJS.WriteStream);

  const ProxyConstructor = proxy.constructor as typeof TestOutput;
  assert.equal(ProxyConstructor, physical.constructor);

  const constructed = Reflect.construct(ProxyConstructor, []);
  assert.ok(constructed instanceof TestOutput);
  assert.ok(proxy instanceof ProxyConstructor);
});

void test("resize-safe stdout keeps method references stable", () => {
  const physical = new TestOutput();
  const proxy = toResizeSafeOutput(physical as unknown as NodeJS.WriteStream);
  const proxyProperties = proxy as unknown as Record<string, unknown>;

  assert.equal(proxyProperties["on"], proxyProperties["on"]);
  assert.equal(proxyProperties["off"], proxyProperties["off"]);
  assert.equal(proxyProperties["write"], proxyProperties["write"]);
  assert.equal(proxyProperties["pipe"], proxyProperties["pipe"]);
});

void test("resize-safe stdout keeps fluent listener methods on the proxy", () => {
  const physical = new TestOutput();
  const proxy = toResizeSafeOutput(physical as unknown as NodeJS.WriteStream);
  let resizeCount = 0;
  const onResize = () => {
    resizeCount++;
  };

  const onResult = proxy.on("resize", onResize);
  assert.equal(onResult, proxy);
  assert.equal(onResult.rows, Number.MAX_SAFE_INTEGER);
  physical.emit("resize");

  const offResult = onResult.off("resize", onResize);
  assert.equal(offResult, proxy);
  assert.equal(offResult.rows, Number.MAX_SAFE_INTEGER);
  physical.emit("resize");

  assert.equal(resizeCount, 1);
  assert.equal(physical.listenerCount("resize"), 0);
});

void test("resize-safe stdout once listener fires only once and remains fluent", () => {
  const physical = new TestOutput();
  const proxy = toResizeSafeOutput(physical as unknown as NodeJS.WriteStream);
  let resizeCount = 0;

  const result = proxy.once("resize", () => {
    resizeCount++;
  });
  assert.equal(result, proxy);
  assert.equal(result.rows, Number.MAX_SAFE_INTEGER);

  physical.emit("resize");
  physical.emit("resize");

  assert.equal(resizeCount, 1);
  assert.equal(physical.listenerCount("resize"), 0);
});

void test("resize-safe stdout writes through to the physical stream", () => {
  const physical = new TestOutput();
  const proxy = toResizeSafeOutput(physical as unknown as NodeJS.WriteStream);
  let output = "";
  physical.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const result = proxy.write("hello");

  assert.equal(typeof result, "boolean");
  assert.equal(result, true);
  assert.equal(output, "hello");
});

void test("resize-safe stdout pipe returns the destination without remapping it", async () => {
  const physical = new TestOutput();
  const proxy = toResizeSafeOutput(physical as unknown as NodeJS.WriteStream);
  const destination = new PassThrough();
  let output = "";
  destination.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const result = proxy.pipe(destination);
  assert.equal(result, destination);

  proxy.end("hello");
  await finished(destination);

  assert.equal(output, "hello");
});

class TestOutput extends PassThrough {
  public readonly isTTY = true;
  public columns = 80;
  public rows = 24;
}
