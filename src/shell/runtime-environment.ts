import { readFileSync } from "node:fs";
import { release } from "node:os";
import { resolveExecutionShell, UnsupportedEnvironmentError } from "./execution-environment.js";

export interface RuntimeEnvironment {
  operatingSystem: string;
  kernelRelease: string;
  distribution: string | null;
  executionShell: string | null;
}

interface RuntimeEnvironmentOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  kernelRelease?: string;
  readOsRelease?: (path: string) => string;
}

export function detectRuntimeEnvironment(
  options: RuntimeEnvironmentOptions = {},
): RuntimeEnvironment {
  const platform = options.platform ?? process.platform;
  let executionShell: string | null = null;
  try {
    executionShell = resolveExecutionShell(options.env ?? process.env, platform);
  } catch (error) {
    // --print 不要求 shell 受支持；交互和执行入口仍使用原有的强校验。
    if (!(error instanceof UnsupportedEnvironmentError)) throw error;
  }

  return {
    operatingSystem: platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform,
    kernelRelease: options.kernelRelease ?? release(),
    distribution:
      platform === "linux"
        ? readLinuxDistribution(options.readOsRelease ?? ((path) => readFileSync(path, "utf8")))
        : null,
    executionShell,
  };
}

function readLinuxDistribution(readOsRelease: (path: string) => string): string | null {
  for (const path of ["/etc/os-release", "/usr/lib/os-release"]) {
    let content: string;
    try {
      content = readOsRelease(path);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return null;
      continue;
    }

    // 只读取发行版标识，不 source 文件、不展开变量，也不发送其他系统配置。
    const fields = new Map<string, string>();
    for (const line of content.split(/\r?\n/)) {
      const match = /^(PRETTY_NAME|NAME|ID|VERSION_ID)=(.*)$/.exec(line.trim());
      if (match === null) continue;
      const value = parseOsReleaseValue(match[2]);
      if (value !== null) fields.set(match[1], value);
    }

    const prettyName = fields.get("PRETTY_NAME");
    if (prettyName) return prettyName;
    const name = fields.get("NAME") || fields.get("ID");
    // /etc/os-release 可读时不混入 /usr/lib/os-release 的字段。
    return name ? [name, fields.get("VERSION_ID")].filter(Boolean).join(" ") : null;
  }
  return null;
}

function parseOsReleaseValue(value: string): string | null {
  if (/^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
  }
  return /^[a-zA-Z0-9._-]+$/.test(value) ? value : null;
}
