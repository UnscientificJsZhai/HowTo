import { userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { getConfigFilePath } from "../../../src/config-file.js";

// 只计算路径，不读取或写入真实用户配置，也不把系统目录写入测试输出。
try {
  const actualPath = getConfigFilePath();
  process.stdout.write(
    `${JSON.stringify({
      matchesSystemHome: actualPath === join(userInfo().homedir, ".howto", "config.json"),
      absolute: isAbsolute(actualPath),
    })}\n`,
  );
} catch {
  process.stderr.write("failed to compute config path in test\n");
  process.exitCode = 1;
}
