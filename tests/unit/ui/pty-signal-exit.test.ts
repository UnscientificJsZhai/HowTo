import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// forkpty 创建独立会话和控制终端；就绪由输出握手确认，超时只用于失败回收。
const driver = String.raw`
import errno, fcntl, json, os, pty, resource, select, signal, struct, sys, termios, time, tty

node, fixture, test_home, phase, action = sys.argv[1:]
start_read, start_write = os.pipe()
pid, fd = pty.fork()
if pid == 0:
    os.close(start_write)
    os.read(start_read, 1)
    os.close(start_read)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.chdir(test_home)
    os.execve(node, [node, fixture, phase], {
        'HOME': test_home, 'PATH': '/usr/bin:/bin',
        'TERM': 'xterm-256color', 'SHELL': '/bin/sh', 'FORCE_COLOR': '0',
    })
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 100, 0, 0))
os.close(start_read)
if phase == 'raw-confirm':
    tty.setraw(fd)
original_attrs = termios.tcgetattr(fd)
original_flags = original_attrs[3]
os.write(start_write, b'1')
os.close(start_write)
output = bytearray()
status = None
eof = False

def interrupted(signum, frame):
    raise RuntimeError('PTY driver interrupted')
signal.signal(signal.SIGTERM, interrupted)

def read_ready(deadline):
    global eof
    ready, _, _ = select.select([fd], [], [], max(0, deadline - time.monotonic()))
    if ready:
        try:
            chunk = os.read(fd, 65536)
            output.extend(chunk)
            eof = not chunk
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            eof = True

def wait_for(marker, start=0):
    deadline = time.monotonic() + 5
    while marker not in output[start:] and not eof and time.monotonic() < deadline:
        read_ready(deadline)
    assert marker in output[start:], 'missing ' + repr(marker) + ': ' + repr(bytes(output[-3000:]))

try:
    mask = termios.ICANON | termios.ECHO
    assert original_flags & mask == (0 if phase == 'raw-confirm' else mask), 'unexpected initial terminal mode'
    if phase == 'init':
        wait_for(b'Choose AI provider')
    elif phase == 'loading':
        wait_for(b'PROVIDER_PENDING')
        wait_for(b'Thinking...')
    else:
        wait_for(b'Select a command')
        if phase != 'select':
            os.write(fd, b'\r')
            wait_for(b'PLACEHOLDER_SENTINEL' if phase == 'placeholder' else b'Final command:')
        if phase in ('paste', 'resize-paste'):
            os.write(fd, b'\x1b[200~pasted\x1b[201~')
            wait_for('仅输出:'.encode())
    if phase in ('resize-paste', 'tiny'):
        for rows, columns in ([(1, 12), (0, 12), (2, 8), (5, 20), (24, 100)] if phase == 'resize-paste' else [(1, 12)]):
            cursor = len(output)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, columns, 0, 0))
            deadline = time.monotonic() + 5
            expected_size = str(rows) + ':' + str(columns)
            while time.monotonic() < deadline:
                try:
                    with open(os.path.join(test_home, 'size')) as f:
                        if f.read() == expected_size:
                            break
                except FileNotFoundError:
                    pass
                read_ready(min(deadline, time.monotonic() + 0.01))
            else:
                raise AssertionError('resize not observed: ' + expected_size)
            assert not os.path.exists(os.path.join(test_home, 'executed'))
            if rows == 24:
                wait_for('仅输出:'.encode(), cursor)
    assert os.tcgetpgrp(fd) == pid, 'Node does not own the controlling terminal'
    assert termios.tcgetattr(fd)[3] & mask == 0, 'session did not acquire raw mode'
    assert output.count(b'\x1b[?2004h') == 1, 'paste mode must be enabled once'
    assert b'\x1b[?2004l' not in output, 'paste mode released before exit'

    if action.startswith('SIG'):
        os.kill(pid, getattr(signal, action))
    else:
        os.write(fd, {'ctrl-c': b'\x03', 'escape': b'\x1b', 'complete': b'\r'}[action])

    deadline = time.monotonic() + 5
    while status is None and time.monotonic() < deadline:
        exited, exit_status = os.waitpid(pid, os.WNOHANG)
        if exited == pid:
            status = exit_status
            break
        read_ready(min(deadline, time.monotonic() + 0.05))
    assert status is not None, 'Node did not exit: ' + repr(bytes(output[-3000:]))
    # waitpid 后继续排空内核中已经写入的终端输出，避免遗漏最后的关闭序列。
    while not eof and time.monotonic() < deadline:
        read_ready(deadline)
    restored_attrs = termios.tcgetattr(fd)
    restored_flags = restored_attrs[3]
    assert restored_flags & mask == original_flags & mask, 'canonical/ECHO not restored'
    # 仅比较 raw 模式会更改的 termios 位，而不是平台相关的完整字节布局。
    for index, changed_mask in [(0, termios.BRKINT | termios.ICRNL | termios.INPCK | termios.ISTRIP | termios.IXON), (1, termios.OPOST), (2, termios.CSIZE | termios.PARENB), (3, termios.ECHO | termios.ICANON | termios.IEXTEN | termios.ISIG)]:
        assert restored_attrs[index] & changed_mask == original_attrs[index] & changed_mask, 'termios field not restored: ' + str(index)
    assert b'\x1b[?25h' in output, 'cursor was not restored'
    assert output.count(b'\x1b[?2004l') == 1, 'paste mode must be disabled exactly once: ' + repr(bytes(output[-3000:]))
    # Ink 的帧必须先卸载；restore-cursor 的独立退出钩子仍可补发显示光标。
    after_disable = bytes(output).split(b'\x1b[?2004l', 1)[1].replace(b'\x1b[?25h', b'')
    assert b'\x1b[' not in after_disable, 'Ink wrote terminal controls after session cleanup'
    exit_code = os.waitstatus_to_exitcode(status)
    if action.startswith('SIG'):
        assert os.WIFSIGNALED(status), 'Node converted signal termination into an exit code'
        assert os.WTERMSIG(status) == getattr(signal, action), 'Node changed the exit signal'
        assert b'FIXTURE_EXIT:' not in output, 'signal unexpectedly completed the normal path'
    else:
        expected = 0 if action == 'complete' else 130
        assert os.WIFEXITED(status) and exit_code == expected, 'wrong normal exit: ' + repr(bytes(output[-3000:]))
        assert ('FIXTURE_EXIT:' + str(expected)).encode() in output
    assert (b'COMMAND_EXECUTED' in output) == (action == 'complete' and phase in ('confirm', 'raw-confirm'))
    assert (b'COMMAND_PRINTED' in output) == (action == 'complete' and phase in ('paste', 'resize-paste'))
    print(json.dumps({'phase': phase, 'action': action, 'exitCode': exit_code, 'canonical': bool(restored_flags & termios.ICANON), 'echo': bool(restored_flags & termios.ECHO), 'pasteDisableCount': 1}))
finally:
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    os.close(fd)
`;

for (const [phase, action] of [
  ["init", "ctrl-c"],
  ["loading", "SIGTERM"],
  ["confirm", "ctrl-c"],
  ["confirm", "complete"],
  ["paste", "complete"],
  ["resize-paste", "complete"],
] as const) {
  void test(`真实 PTY ${phase} / ${action} 恢复终端并保留退出语义`, (t) => {
    if (process.platform === "win32") {
      t.skip("此自动回归需要 POSIX 控制终端");
      return;
    }
    const testHome = mkdtempSync(join(tmpdir(), "howto-pty-signal-exit-"));
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          driver,
          process.execPath,
          fileURLToPath(new URL("./fixtures/pty-signal-exit.js", import.meta.url)),
          testHome,
          phase,
          action,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: testHome },
          encoding: "utf8",
          timeout: 25_000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (result.error && "code" in result.error && result.error.code === "ENOENT") {
        assert.ok(!process.env.CI, "CI 必须提供 Python3 以执行真实 PTY 回归");
        t.skip("未找到 Python3，真实 PTY 回归未执行");
        return;
      }
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(
        existsSync(join(testHome, "executed")),
        action === "complete" && phase === "confirm",
      );
      assert.equal(
        existsSync(join(testHome, "printed")),
        action === "complete" && (phase === "paste" || phase === "resize-paste"),
      );
      t.diagnostic(
        `Node ${process.versions.node} / libuv ${process.versions.uv}: ${result.stdout.trim()}`,
      );
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
}
