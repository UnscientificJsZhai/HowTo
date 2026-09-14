import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CHILD_ENTRYPOINT = fileURLToPath(
  new URL("./fixtures/provider-cancellation-child.js", import.meta.url),
);

// Python 仅负责 PTY 和按键；自然退出必须先于超时回收，不能用强制退出代替。
const driver = String.raw`
import errno, fcntl, json, os, pty, re, select, signal, struct, sys, termios, time

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
sent = False
started = time.monotonic()

def interrupted(signum, frame):
    raise RuntimeError('PTY driver interrupted')
signal.signal(signal.SIGTERM, interrupted)

try:
    deadline = started + 5
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.02)
        if ready:
            try:
                output.extend(os.read(fd, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        # 确认 UI 可见且终端已经进入 raw，Ctrl+C 才由应用处理而非直接发送 SIGINT。
        if mode == 'cancel' and not sent and b'HOWTO_PROVIDER_PENDING' in output and b'Thinking...' in output and not (termios.tcgetattr(fd)[3] & termios.ISIG):
            os.write(fd, b'\x03')
            sent = True
        exited, exit_status = os.waitpid(pid, os.WNOHANG)
        if exited == pid:
            status = exit_status
            break
    assert status is not None, 'CLI did not exit naturally before retry backoff: ' + repr(bytes(output[-2000:]))
    assert mode != 'cancel' or sent, 'Ctrl+C was not delivered through the raw terminal'
    # 子进程退出后排空 PTY，保留 exit 回调的完整记录。
    while select.select([fd], [], [], 0)[0]:
        try:
            tail = os.read(fd, 65536)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not tail:
            break
        output.extend(tail)
    records = [json.loads(item) for item in re.findall(rb'HOWTO_PROVIDER_RESULT:(\{[^\r\n]*\})', bytes(output))]
    assert len(records) == 2, 'missing lifecycle records: ' + repr(bytes(output[-2000:]))
    expected_code = 130 if mode == 'cancel' else 1
    assert os.waitstatus_to_exitcode(status) == expected_code
    assert all(item['exitCode'] == expected_code and item['requestCount'] == 1 for item in records)
    assert all(item['abortCount'] == (1 if mode == 'cancel' else 0) for item in records)
    assert [item['event'] for item in records] == ['returned', 'exit']
    assert records[1]['elapsedMs'] - records[0]['elapsedMs'] < 1000, 'a live SDK timer delayed exit'
    assert b'HOWTO_FAKE_' not in output
    provider_error = b'AI provider request failed (provider: openai, model: gpt-test)'
    assert (provider_error in output) == (mode == 'rate-limit')
    print(json.dumps({'mode': mode, 'records': records, 'naturalExitMs': round((time.monotonic() - started) * 1000)}))
finally:
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(fd)
`;

for (const mode of ["rate-limit", "cancel"]) {
  test(`OpenAI 真实 CLI ${mode === "cancel" ? "Ctrl+C 取消" : "429 失败"}后不保留 SDK 重试等待`, (t) => {
    if (process.platform === "win32") {
      t.skip("真实终端回归需要 POSIX PTY；Windows Console/ConPTY 需单独验收");
      return;
    }
    const testHome = mkdtempSync(join(tmpdir(), "howto-provider-cancel-"));
    try {
      const child = spawnSync(
        "python3",
        ["-c", driver, process.execPath, CHILD_ENTRYPOINT, testHome, mode],
        {
          env: { PATH: "/usr/bin:/bin", HOME: testHome },
          encoding: "utf8",
          timeout: 8_000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (child.error && "code" in child.error && child.error.code === "ENOENT") {
        t.skip("未找到 Python3，真实 PTY 回归未执行");
        return;
      }
      assert.ifError(child.error);
      assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
      // CLI 的 stdout/stderr 均在 PTY 中；这里仅记录 Python 启动器的宿主诊断。
      if (child.stderr !== "") t.diagnostic(child.stderr.trim());
      t.diagnostic(`Node ${process.versions.node}: ${child.stdout.trim()}`);
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
}
