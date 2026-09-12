import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));

  while (true) {
    let content: string;

    try {
      content = readFileSync(join(directory, "package.json"), "utf8");
    } catch (error: unknown) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw new Error("failed to read package version", { cause: error });
      }

      const parentDirectory = dirname(directory);
      if (parentDirectory === directory) {
        throw new Error("package.json not found", { cause: error });
      }

      directory = parentDirectory;
      continue;
    }

    let metadata: unknown;
    try {
      metadata = JSON.parse(content);
    } catch {
      throw new Error("package.json is not valid JSON");
    }

    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("version" in metadata) ||
      typeof metadata.version !== "string" ||
      metadata.version.trim() === ""
    ) {
      throw new Error("package.json must contain a version string");
    }

    return metadata.version;
  }
}
