import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Python 仅提供标准库 PTY 驱动；每一步依赖输出握手，时间上限只用于失败回收。
const driver = String.raw`
import errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time

node, fixture, test_home, mode = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(test_home)
    os.execve(node, [node, fixture, mode], {
        'HOME': test_home, 'PATH': '/usr/bin:/bin',
        'TERM': 'xterm-256color', 'SHELL': '/bin/sh', 'FORCE_COLOR': '0',
    })
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
output = bytearray()
status = None

def interrupted(signum, frame):
    raise RuntimeError('PTY driver interrupted')
signal.signal(signal.SIGTERM, interrupted)

def read_ready(deadline):
    ready, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
    if ready:
        try:
            output.extend(os.read(fd, 65536))
        except OSError as error:
            if error.errno != errno.EIO:
                raise

def wait_for(marker):
    deadline = time.monotonic() + 5
    while marker not in output and time.monotonic() < deadline:
        read_ready(deadline)
    assert marker in output, 'missing ' + repr(marker) + ': ' + repr(bytes(output[-3000:]))

try:
    wait_for(b'Select a command')
    os.write(fd, b'\r')
    wait_for(b'Final command:')
    # 本测试只用键盘；若本地规则要求危险确认，同样完整输入确认短语。
    os.write(fd, b'EXECUTE\r' if b'EXECUTE+Enter' in output else b'\r')
    wait_for(b'REVIEW_CHILD_READY\r\n')
    os.write(fd, b'verified\n')
    wait_for(b'REVIEW_CHILD_LINE:verified\r\n')
    wait_for(b'REVIEW_EXIT:0\r\n')
    wait_for(b'ORIGINAL_READY\r\n')
    os.write(fd, b'parent-verified\n')
    wait_for(b'REVIEW_FINISHED:')
    deadline = time.monotonic() + 5
    while status is None and time.monotonic() < deadline:
        exited, exit_status = os.waitpid(pid, os.WNOHANG)
        if exited == pid:
            status = exit_status
            break
        read_ready(deadline)
    assert status is not None, 'Node did not exit naturally'
    assert os.waitstatus_to_exitcode(status) == 0, 'Node exited unsuccessfully'
    print(json.dumps({'mode': mode, 'firstLine': 'verified', 'parentLine': 'parent-verified', 'nodeExit': 0}))
finally:
    # 强制终止只用于失败/超时回收，不能代替上面的自然退出断言。
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(fd)
`;

for (const mode of ["normal", "raw"]) {
  void test(`真实 PTY ${mode} 模式完整交付子命令首行，原 stdin 可复用且自然退出`, (t) => {
    if (process.platform === "win32") {
      t.skip("此自动回归需要 POSIX PTY；Windows Console/ConPTY 需独立验收");
      return;
    }
    const testHome = mkdtempSync(join(tmpdir(), "howto-pty-handoff-"));
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          driver,
          process.execPath,
          fileURLToPath(new URL("./fixtures/pty-handoff.js", import.meta.url)),
          testHome,
          mode,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: testHome },
          encoding: "utf8",
          timeout: 35_000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (result.error && "code" in result.error && result.error.code === "ENOENT") {
        t.skip("未找到 Python3，真实 PTY 回归未执行");
        return;
      }
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /"nodeExit": 0/);
      t.diagnostic(
        `Node ${process.versions.node} / libuv ${process.versions.uv}: ${result.stdout.trim()}`,
      );
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
}
