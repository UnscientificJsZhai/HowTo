import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// 沿用现有 forkpty 验收设施，以输出和文件握手同步；固定超时只用于失败清理。
const driver = String.raw`
import errno, fcntl, json, os, pty, resource, select, signal, struct, sys, termios, time

node, fixture, test_home, phase = sys.argv[1:]
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
original_attrs = termios.tcgetattr(fd)
os.write(start_write, b'1')
os.close(start_write)
output = bytearray()
status = None
eof = False
query_pid = None

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

def wait_for_query():
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            with open(os.path.join(test_home, 'query-pid')) as handle:
                return int(handle.read())
        except FileNotFoundError:
            read_ready(min(deadline, time.monotonic() + 0.02))
    raise AssertionError('query did not start: ' + repr(bytes(output[-3000:])))

def process_gone(target):
    try:
        os.kill(target, 0)
        return False
    except ProcessLookupError:
        return True

try:
    mask = termios.ICANON | termios.ECHO
    assert original_attrs[3] & mask == mask, 'unexpected initial terminal mode'
    wait_for('查询审批'.encode())
    wait_for(b'PTY_QUERY_PURPOSE')
    assert not os.path.exists(os.path.join(test_home, 'query-pid')), 'unapproved query started'
    assert termios.tcgetattr(fd)[3] & mask == 0, 'session did not acquire raw mode'
    assert os.tcgetpgrp(fd) == pid, 'Node does not own the controlling terminal'
    assert output.count(b'\x1b[?2004h') == 1, 'paste mode must be enabled once'
    assert b'\x1b[?2004l' not in output, 'paste mode released before completion'

    if phase != 'approval':
        os.write(fd, b'\r')
        wait_for('查询运行中'.encode())
        query_pid = wait_for_query()
        assert not process_gone(query_pid), 'query exited before cancellation'
    if phase == 'paste':
        os.write(fd, b'\x1b[200~ignored\r\x1b[201~')
        wait_for(b'Select a command')
        with open(os.path.join(test_home, 'tool-result.json')) as handle:
            result = json.load(handle)
        assert result['status'] == 'permission_revoked', 'paste did not revoke query permission'
        assert result['stdout'] == 'QUERY_PARTIAL_OUTPUT\n', 'partial query output was lost'
        assert result['actualCommand'] is not None, 'executed query command was not returned'
        assert not os.path.exists(os.path.join(test_home, 'executed')), 'paste executed final command'
        os.write(fd, b'\r')
        wait_for('仅输出:'.encode())
        os.write(fd, b'\r')
    else:
        os.write(fd, b'\x03')

    deadline = time.monotonic() + 5
    while status is None and time.monotonic() < deadline:
        exited, exit_status = os.waitpid(pid, os.WNOHANG)
        if exited == pid:
            status = exit_status
            break
        read_ready(min(deadline, time.monotonic() + 0.05))
    assert status is not None, 'Node did not exit: ' + repr(bytes(output[-3000:]))
    while not eof and time.monotonic() < deadline:
        read_ready(deadline)
    restored_attrs = termios.tcgetattr(fd)
    assert restored_attrs[3] & mask == original_attrs[3] & mask, 'canonical/ECHO not restored'
    for index, changed_mask in [(0, termios.BRKINT | termios.ICRNL | termios.INPCK | termios.ISTRIP | termios.IXON), (1, termios.OPOST), (2, termios.CSIZE | termios.PARENB), (3, termios.ECHO | termios.ICANON | termios.IEXTEN | termios.ISIG)]:
        assert restored_attrs[index] & changed_mask == original_attrs[index] & changed_mask, 'termios field not restored: ' + str(index)
    assert output.count(b'\x1b[?2004l') == 1, 'paste mode must be disabled exactly once'
    assert b'\x1b[?25h' in output, 'cursor was not restored'
    after_disable = bytes(output).split(b'\x1b[?2004l', 1)[1].replace(b'\x1b[?25h', b'')
    assert b'\x1b[' not in after_disable, 'Ink wrote terminal controls after session cleanup'
    expected = 0 if phase == 'paste' else 130
    exit_code = os.waitstatus_to_exitcode(status)
    assert os.WIFEXITED(status) and exit_code == expected, 'wrong exit: ' + repr(bytes(output[-3000:]))
    assert ('FIXTURE_EXIT:' + str(expected)).encode() in output
    assert b'COMMAND_EXECUTED' not in output
    assert (b'COMMAND_PRINTED' in output) == (phase == 'paste')
    if query_pid is not None:
        deadline = time.monotonic() + 2
        while not process_gone(query_pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        assert process_gone(query_pid), 'query process survived cancellation'
    print(json.dumps({'phase': phase, 'exitCode': exit_code, 'canonical': True, 'echo': True, 'pasteDisableCount': 1, 'queryCleaned': query_pid is not None}))
finally:
    if status is None:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
    if query_pid is None:
        try:
            with open(os.path.join(test_home, 'query-pid')) as handle:
                query_pid = int(handle.read())
        except FileNotFoundError:
            pass
    if query_pid is not None and not process_gone(query_pid):
        try:
            os.killpg(query_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    os.close(fd)
`;

for (const phase of ["approval", "running", "paste"] as const) {
  void test(`真实 PTY 查询 ${phase} ${phase === "paste" ? "粘贴后仅输出" : "Ctrl+C 退出 130"}并恢复终端`, (t) => {
    if (process.platform === "win32") {
      t.skip("此自动回归需要 POSIX 控制终端");
      return;
    }
    const testHome = mkdtempSync(join(tmpdir(), "howto-pty-usage-"));
    try {
      const result = spawnSync(
        "python3",
        [
          "-c",
          driver,
          process.execPath,
          fileURLToPath(new URL("./fixtures/pty-usage.js", import.meta.url)),
          testHome,
          phase,
        ],
        {
          env: { PATH: "/usr/bin:/bin", HOME: testHome },
          encoding: "utf8",
          timeout: 25_000,
          maxBuffer: 1024 * 1024,
        },
      );
      if (result.error && "code" in result.error && result.error.code === "ENOENT") {
        assert.ok(!process.env["CI"], "CI 必须提供 Python3 以执行真实 PTY 回归");
        t.skip("未找到 Python3，真实 PTY 回归未执行");
        return;
      }
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal(existsSync(join(testHome, "executed")), false);
      assert.equal(existsSync(join(testHome, "printed")), phase === "paste");
      assert.equal(existsSync(join(testHome, "query-pid")), phase !== "approval");
      if (phase === "paste") {
        assert.match(
          readFileSync(join(testHome, "tool-result.json"), "utf8"),
          /permission_revoked/,
        );
      }
      t.diagnostic(
        `Node ${process.versions.node} / libuv ${process.versions.uv}: ${result.stdout.trim()}`,
      );
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  });
}
