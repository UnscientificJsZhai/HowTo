import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

for (const endpoint of ["stdin", "stdout"] as const) {
  test(`独立真实 PTY 关闭 ${endpoint}，无控制终端 SIGHUP 干扰`, (t) => {
    const home = mkdtempSync(join(tmpdir(), "howto-io-close-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    const result = spawnSync(
      "python3",
      [
        "-c",
        String.raw`
import errno, fcntl, os, pty, select, signal, struct, subprocess, sys, termios, time
node, fixture, home, endpoint = sys.argv[1:]
im, ins = pty.openpty()
om, outs = pty.openpty()
fcntl.ioctl(outs, termios.TIOCSWINSZ, struct.pack('HHHH',24,100,0,0))
p = subprocess.Popen([node, fixture, 'loading' if endpoint == 'stdout' else 'select'], stdin=ins, stdout=outs, stderr=subprocess.PIPE, cwd=home, start_new_session=True, env={'HOME':home,'PATH':'/usr/bin:/bin','SHELL':'/bin/sh','TERM':'xterm-256color','FORCE_COLOR':'0'})
os.close(ins)
os.close(outs)
output=bytearray()
try:
    deadline=time.monotonic()+5
    marker=b'Thinking...' if endpoint=='stdout' else b'Select a command'
    while marker not in output and time.monotonic()<deadline:
        if select.select([om],[],[],max(0,deadline-time.monotonic()))[0]: output.extend(os.read(om,65536))
    assert marker in output, repr(bytes(output[-2000:]))
    if endpoint == 'stdin': os.close(im); im=None
    if endpoint == 'stdout': os.close(om); om=None
    _,errors=p.communicate(timeout=5)
    assert p.returncode==1, (p.returncode,errors,bytes(output[-2000:]))
    print(endpoint+': exit 1, no signal termination')
finally:
    if p.poll() is None: os.killpg(p.pid,signal.SIGKILL)
    p.communicate()
    if im is not None: os.close(im)
    if om is not None: os.close(om)
`,
        process.execPath,
        fileURLToPath(new URL("./fixtures/pty-io-close.js", import.meta.url)),
        home,
        endpoint,
      ],
      {
        env: { PATH: "/usr/bin:/bin" },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(home, "executed")), false);
    assert.equal(existsSync(join(home, "printed")), false);
    const observed = JSON.parse(readFileSync(join(home, "result.json"), "utf8")) as {
      exitCode: number;
      events: string[];
    };
    assert.equal(observed.exitCode, 1);
    assert.ok(
      observed.events.some(
        (event) => event.startsWith("session:failure") || event.startsWith("stdout:"),
      ),
      JSON.stringify(observed),
    );
    if (endpoint === "stdout") assert.ok(observed.events.includes("provider:abort"));
    t.diagnostic(JSON.stringify({ endpoint, ...observed }));
  });
}
