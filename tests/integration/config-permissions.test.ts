import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readUserConfigFile } from "../../src/config-file.js";

async function writeRawConfig(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

for (const umask of [0o000, 0o022, 0o077]) {
  for (const initialMode of [undefined, 0o600, 0o644]) {
    const scenario = initialMode === undefined ? "新建" : `替换 ${initialMode.toString(8)}`;
    test(
      `配置文件在 umask ${umask.toString(8)} 下${scenario}时仅所有者可读写`,
      { skip: process.platform === "win32" },
      async (t) => {
        const parentDirectory = await mkdtemp(join(tmpdir(), "howto-config-permissions-"));
        t.after(() => rm(parentDirectory, { recursive: true, force: true }));
        const path = join(parentDirectory, ".howto", "config.json");
        if (initialMode !== undefined) {
          await writeRawConfig(path, '{"aiProvider":"openai","openaiApiKey":"old-test-key"}');
          await chmod(path, initialMode);
          assert.equal((await stat(path)).mode & 0o777, initialMode);
        }

        // 在独立子进程中设置 umask，避免影响同进程内的其他测试。
        const result = spawnSync(
          process.execPath,
          [
            fileURLToPath(new URL("./fixtures/config-permissions-child.js", import.meta.url)),
            path,
            String(umask),
          ],
          { encoding: "utf8", timeout: 5_000 },
        );

        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(result.stderr, "");
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.deepEqual(await readUserConfigFile(path), {
          aiProvider: "gemini",
          geminiApiKey: "new-test-key",
          geminiModel: "test-model",
        });
      },
    );
  }
}
