import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { createRequire } from "node:module";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

const require = createRequire(import.meta.url);
const manifest = require("../package.json");
const native = require("@typescript/native/package.json");
const compatibility = require("typescript/package.json");
const parserRequire = createRequire(require.resolve("@typescript-eslint/typescript-estree"));
const api = parserRequire("typescript");
const compiler = fileURLToPath(
  new URL("../node_modules/@typescript/native/bin/tsc", import.meta.url),
);
const compilerVersion = execFileSync(process.execPath, [compiler, "--version"], {
  encoding: "utf8",
}).trim();
assert.equal(native.name, "typescript");
assert.match(native.version, /^7\./);
assert.equal(compilerVersion, `Version ${native.version}`);
assert.equal(compatibility.name, "@typescript/typescript6");
assert.match(api.version, /^6\.0\./);
assert.equal(typeof api.createProgram, "function");
assert.equal(parserRequire.resolve("typescript"), require.resolve("typescript"));
for (const script of ["build", "build:test"]) {
  assert.ok(manifest.scripts[script].includes("node ./node_modules/@typescript/native/bin/tsc"));
}

console.log(
  JSON.stringify({
    compiler: native.version,
    compatibility: compatibility.version,
    eslintApi: api.version,
  }),
);
