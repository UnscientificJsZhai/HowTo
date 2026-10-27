import { spawn } from "node:child_process";
import { writeFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args[0];
if (mode === "workspace" && args[1] === "deployment" && args[2] === "--help") {
  process.stdout.write("Usage: test-cli workspace deployment create --name <name>\n");
} else if (mode === "stderr-help") {
  process.stderr.write("Usage: test-cli unusual --help\n");
  process.exitCode = 3;
} else if (mode === "echo") {
  process.stdout.write(JSON.stringify(args.slice(1)));
} else if (mode === "stdin") {
  process.stdin.once("end", () => process.stdout.write("stdin closed\n"));
  process.stdin.resume();
} else if (mode === "cwd") {
  process.stdout.write(process.cwd());
} else if (mode === "marker") {
  writeFileSync(args[1], "started");
} else if (mode === "long") {
  writeSync(
    process.stdout.fd,
    "A".repeat(24 * 1024) + "middle".repeat(4000) + "Z".repeat(8 * 1024),
  );
  writeSync(
    process.stderr.fd,
    "B".repeat(24 * 1024) + "middle".repeat(4000) + "Y".repeat(8 * 1024),
  );
} else if (mode === "wait") {
  process.on("SIGTERM", () => {});
  writeFileSync(args[1], String(process.pid));
  process.stdout.write("partial output\n");
  setInterval(() => {}, 1_000);
} else if (mode === "descendant") {
  process.on("SIGTERM", () => {});
  writeFileSync(args[1], String(process.pid));
  process.send?.("ready");
  process.disconnect?.();
  if (args[2] === "bounded") setTimeout(() => process.exit(0), 15_000);
  setInterval(() => {}, 1_000);
} else if (mode === "detached-pipes") {
  writeFileSync(args[2], String(process.pid));
  const child = spawn(process.execPath, [import.meta.filename, "descendant", args[1], "bounded"], {
    detached: true,
    stdio: ["ignore", process.stdout.fd, process.stderr.fd, "ipc"],
  });
  child.once("message", () => {
    writeSync(process.stdout.fd, "partial stdout\n");
    writeSync(process.stderr.fd, "partial stderr\n");
    process.exit(0);
  });
} else if (mode === "group" || mode === "group-exit") {
  const child = spawn(process.execPath, [import.meta.filename, "descendant", args[1]], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  process.on("SIGTERM", () => process.exit(0));
  child.once("message", () => {
    process.stdout.write(`parent=${process.pid};child=${child.pid}\n`, () => {
      if (mode === "group-exit") process.exit(0);
    });
  });
  setInterval(() => {}, 1_000);
} else {
  process.stderr.write("Unknown test CLI invocation\n");
  process.exitCode = 2;
}
