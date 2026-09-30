import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// 只使用 Node 标准库；目标必须是隔离安装后的 npm bin，可用最低支持 Node 运行。
const entryArgument = process.argv[2];
assert.ok(entryArgument, "必须提供隔离安装后的 npm bin 路径");
const entry = resolve(entryArgument);
const packageRoot = dirname(dirname(realpathSync(entry)));
const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.ok(manifest !== null && typeof manifest === "object" && "version" in manifest);
assert.ok(typeof manifest.version === "string");
assert.match(manifest.version, /^\d+\.\d+\.\d+/);
assert.equal(readFileSync(realpathSync(entry), "utf8").startsWith("#!/usr/bin/env node"), true);
const home = mkdtempSync(join(tmpdir(), "howto-package 空格-"));
const command = "printf 'PACKAGE_%s\\n' EXECUTED";
let requests = 0;
const server = createServer((request, response) => {
  requests++;
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                commands: [
                  {
                    title: "Safe print",
                    description: "Only print",
                    command,
                    dangerous: false,
                    dangerReason: "",
                    placeholders: [],
                  },
                ],
              }),
            },
          },
        ],
      }),
    );
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const env = {
  HOME: home,
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  FORCE_COLOR: "0",
  HOWTO_AI_PROVIDER: "openai",
  HOWTO_OPENAI_API_KEY: "",
  HOWTO_OPENAI_MODEL: "offline-test",
  HOWTO_OPENAI_API_URL: `http://127.0.0.1:${address.port}/v1`,
};
interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function run(
  executable: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise<RunResult>((resolveResult, reject) => {
    const child = spawn(executable, args, {
      env: { ...env, ...extra },
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 25000,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value: Buffer) => {
      stdout += value.toString();
    });
    child.stderr.on("data", (value: Buffer) => {
      stderr += value.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal, stdout, stderr }));
    child.stdin.end();
  });
}
try {
  const versionResult = await run(entry, ["--version"], { SHELL: "/bin/fish" });
  assert.equal(versionResult.code, 0);
  assert.equal(versionResult.signal, null);
  assert.match(versionResult.stdout, /^\d+\.\d+\.\d+\r?\n$/);
  assert.equal(versionResult.stderr, "");
  const missing = await run(entry, ["--print", "test"], { HOWTO_AI_PROVIDER: "" });
  assert.equal(missing.code, 2);
  assert.equal(missing.stdout, "");
  const interactive = await run(entry, ["test"]);
  assert.equal(interactive.code, 2);
  assert.match(interactive.stderr, /requires a TTY/);
  assert.equal(requests, 0);
  assert.deepEqual(await run(entry, ["--print", "print harmless text"], { SHELL: "/bin/fish" }), {
    code: 0,
    signal: null,
    stdout: `${command}\n`,
    stderr: "",
  });
  assert.equal(requests, 1);
  for (const mode of ["confirm", "paste"]) {
    const result = await run("python3", [
      "-c",
      String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
entry, mode = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0: os.execve(entry,[entry,'print harmless text'],dict(os.environ))
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',24,100,0,0))
output=bytearray()
status=None

def interrupted(signum, frame):
    raise RuntimeError('PTY driver interrupted; collecting child processes')
signal.signal(signal.SIGTERM, interrupted)

def read_ready(deadline):
    if select.select([fd],[],[],max(0,deadline-time.monotonic()))[0]:
        try: output.extend(os.read(fd,65536))
        except OSError as error:
            if error.errno!=errno.EIO: raise

def wait_for(marker):
    deadline=time.monotonic()+5
    while marker not in output and time.monotonic()<deadline: read_ready(deadline)
    assert marker in output, repr(bytes(output[-2000:]))

try:
    wait_for(b'Select a command')
    os.write(fd,b'\r')
    wait_for(b'Final command:')
    if mode=='paste':
        os.write(fd,b'\x1b[200~pasted\x1b[201~')
        wait_for('仅输出:'.encode())
    os.write(fd,b'\r')
    deadline=time.monotonic()+5
    while status is None and time.monotonic()<deadline:
        exited,value=os.waitpid(pid,os.WNOHANG)
        if exited==pid: status=value
        else: read_ready(min(deadline,time.monotonic()+0.02))
    assert status is not None, 'package CLI hung'
    read_ready(time.monotonic()+0.05)
    assert os.waitstatus_to_exitcode(status)==0, repr(bytes(output[-2000:]))
    assert output.count(b'\x1b[?2004h')==1 and output.count(b'\x1b[?2004l')==1
    mask=termios.ICANON|termios.ECHO
    assert termios.tcgetattr(fd)[3]&mask==mask
    assert output.count(b'PACKAGE_EXECUTED\r\n')==(1 if mode=='confirm' else 0), repr(bytes(output[-2000:]))
    if mode=='paste': assert b"printf 'PACKAGE_%s\\n' EXECUTED\r\n" in output
    print(json.dumps({'mode':mode,'exitCode':0,'executions':1 if mode=='confirm' else 0}))
finally:
    if status is None:
        try: os.killpg(pid,signal.SIGKILL)
        except ProcessLookupError: pass
        os.waitpid(pid,0)
    os.close(fd)
`,
      entry,
      mode,
    ]);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    console.log(result.stdout.trim());
  }
  assert.equal(requests, 3);
  console.log(
    JSON.stringify({
      node: process.version,
      uv: process.versions.uv,
      platform: process.platform,
      arch: process.arch,
      version: manifest.version,
      checks: 6,
      requests,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  rmSync(home, { recursive: true, force: true });
}
