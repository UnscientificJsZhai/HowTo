import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../src/index.js", import.meta.url));
const executor = new URL("../../src/execute.js", import.meta.url).href;
const candidate = {
  title: "Print",
  description: "Print only",
  command: "printf '离线 safe'",
  dangerous: false,
  dangerReason: "",
  placeholders: [],
};

for (const shell of [undefined, "sh", "/bin/sh"]) {
  test(`真实 shell ${JSON.stringify(shell)} 保留 cwd、环境、输出与退出状态`, (t) => {
    if (shell?.includes("/") && !existsSync(shell)) {
      t.skip(`${shell} 不可用`);
      return;
    }
    const home = realpathSync(mkdtempSync(join(tmpdir(), "howto-shell 空格-")));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const execute = (command: string) =>
      spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {executeCommand} from ${JSON.stringify(executor)}; process.exitCode = await executeCommand(process.argv[1]);`,
          command,
        ],
        {
          cwd: home,
          env: {
            PATH: "/usr/bin:/bin",
            HOME: home,
            ...(shell === undefined ? {} : { SHELL: shell }),
            HOWTO_TEST_VALUE: "空 格'\"$",
          },
          encoding: "utf8",
          timeout: 5000,
        },
      );
    const result = execute('printf "%s\\n" "$PWD" "$HOWTO_TEST_VALUE"; printf err >&2; exit 7');
    assert.ifError(result.error);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, `${home}\n空 格'"$\n`);
    assert.equal(result.stderr, "err");

    const nonexistent = execute("howto_nonexistent_fixture_command");
    assert.ifError(nonexistent.error);
    assert.equal(nonexistent.status, 127);
  });
}

test("允许名称但不存在或不可执行的 shell 不会静默回退", (t) => {
  const home = mkdtempSync(join(tmpdir(), "howto-shell-error-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  for (const [shell, expected] of [
    [join(home, "sh"), "ENOENT"],
    [join(home, "bash"), "EACCES"],
  ]) {
    if (expected === "EACCES") writeFileSync(shell, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {executeCommand} from ${JSON.stringify(executor)}; try { await executeCommand('printf UNEXPECTED'); } catch (e) { console.log(e.code); process.exitCode = 1; }`,
      ],
      {
        env: { PATH: home, HOME: home, SHELL: shell },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `${expected}\n`);
  }
});

test("真实 loopback HTTP 验证无 TTY CLI、结构化开关及非法响应边界", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "howto-http 空格-"));
  const requests: Record<string, unknown>[] = [];
  let responseText = JSON.stringify({ commands: [candidate] });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      assert.equal(req.url, "/v1/chat/completions");
      requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: responseText } }] }));
    });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const run = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, ...args], {
        env: {
          HOME: home,
          PATH: "/usr/bin:/bin",
          SHELL: "/bin/sh",
          HOWTO_AI_PROVIDER: "openai",
          HOWTO_OPENAI_API_KEY: "",
          HOWTO_OPENAI_MODEL: "offline-test",
          HOWTO_OPENAI_API_URL: `http://127.0.0.1:${address.port}/v1`,
          ...extra,
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end();
    });

  const versionResult = await run(["--version"]);
  assert.equal(versionResult.code, 0);
  assert.match(versionResult.stdout, /^\d+\.\d+\.\d+\r?\n$/);
  assert.equal(versionResult.stderr, "");

  for (const args of [["--init"], ["print harmless text"]]) {
    const result = await run(args, { SHELL: "/bin/sh" });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /requires a TTY/);
    assert.equal(result.stdout, "");
  }
  assert.equal(requests.length, 0);
  assert.equal(existsSync(join(home, ".howto")), false);
  for (const structured of ["true", "false"]) {
    assert.deepEqual(
      await run(["--print", "--", "打印 空格 👩‍💻"], { HOWTO_STRUCTURED_OUTPUT: structured }),
      {
        code: 0,
        stdout: `${candidate.command}\n`,
        stderr: "",
      },
    );
  }
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => (request.response_format as { type: string }).type),
    ["json_schema", "json_object"],
  );
  responseText = "FAKE_PRIVATE_RESPONSE invalid JSON";
  const invalid = await run(["--print", "test"]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, "");
  assert.doesNotMatch(invalid.stderr, /FAKE_PRIVATE_RESPONSE|at file:/);
  assert.equal(invalid.stderr.includes("\u001b"), false);
  assert.equal(requests.length, 3);
});
