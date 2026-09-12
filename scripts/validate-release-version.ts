import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseTagMatchesPackageVersion(
  packageVersion: unknown,
  releaseTag: unknown,
): boolean {
  return (
    typeof packageVersion === "string" &&
    packageVersion.length > 0 &&
    typeof releaseTag === "string" &&
    (releaseTag === packageVersion || releaseTag === `v${packageVersion}`)
  );
}

function main(): number {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(readFileSync("package.json", "utf8")) as unknown;
  } catch {
    process.stderr.write("failed to read package version for release validation\n");
    return 1;
  }

  const packageVersion =
    typeof packageJson === "object" && packageJson !== null && !Array.isArray(packageJson)
      ? (packageJson as { version?: unknown }).version
      : undefined;

  if (!releaseTagMatchesPackageVersion(packageVersion, process.env.RELEASE_TAG)) {
    process.stderr.write("release tag must match package version\n");
    return 1;
  }

  process.stdout.write("Release tag matches package version.\n");
  return 0;
}

// 导入纯函数时不运行发布入口；直接执行源码或编译结果时才读取当前目录。
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main();
}
