import { writeUserConfigFile } from "../../../src/config-file.js";

const [path, umask] = process.argv.slice(2);
if (path === undefined || umask === undefined) {
  throw new Error("配置权限测试缺少参数");
}

// 只向父测试提供的隔离路径写入虚构配置，不访问真实用户配置。
process.umask(Number(umask));
await writeUserConfigFile(
  { aiProvider: "gemini", geminiApiKey: "new-test-key", geminiModel: "test-model" },
  path,
);
