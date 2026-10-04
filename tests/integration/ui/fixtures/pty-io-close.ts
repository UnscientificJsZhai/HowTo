import { writeFileSync } from "node:fs";
import { toAppError } from "../../../../src/errors.js";
import { createInteractiveSession } from "../../../../src/ui/interactive-session.js";
import { runInteractiveCommand } from "../../../../src/ui/run-interactive-command.js";
import { testCandidate, testRequest } from "../../../unit/ui/session-test-helpers.js";

const events: string[] = [];
const session = createInteractiveSession({ input: process.stdin, output: process.stdout });
session.subscribeFailure((err) => events.push(`session:failure:${err.name}`));
for (const event of ["close", "error"] as const) {
  process.stdout.on(event, () => events.push(`stdout:${event}`));
}
try {
  process.exitCode = await runInteractiveCommand({
    session,
    request: testRequest(),
    provider: {
      generateCommands: (_request, signal) =>
        process.argv[2] === "loading"
          ? new Promise((_resolve, reject) => {
              signal?.addEventListener(
                "abort",
                () => {
                  events.push("provider:abort");
                  reject(new Error("cancelled"));
                },
                { once: true },
              );
            })
          : Promise.resolve({ rawText: JSON.stringify({ commands: [testCandidate()] }) }),
    },
    execute: () => {
      writeFileSync("executed", "yes");
      return Promise.resolve(0);
    },
    print: () => writeFileSync("printed", "yes"),
  });
} catch (error) {
  process.exitCode = toAppError(error).exitCode;
} finally {
  session.dispose();
}
process.on("exit", () =>
  writeFileSync("result.json", JSON.stringify({ exitCode: process.exitCode, events })),
);
