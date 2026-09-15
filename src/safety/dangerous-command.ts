import { posix } from "node:path";
import {
  isShellExecutable,
  parseShellCommand,
  resolveCommandPrefix,
  type ShellWord,
} from "../shell/command-analysis.js";

export interface DangerousCommandMatch {
  rule: string;
  reason: string;
}

const INDETERMINATE: DangerousCommandMatch = {
  rule: "indeterminate-shell-command",
  reason: "command structure cannot be assessed locally; additional confirmation required",
};
const DESTRUCTIVE_RM: DangerousCommandMatch = {
  rule: "destructive-rm",
  reason: "recursive or forced rm against a high-risk target",
};
const DISK_OPERATION: DangerousCommandMatch = {
  rule: "disk-filesystem-operation",
  reason: "disk, partition, filesystem, or raw block-device operation",
};
const PERMISSION_CHANGE: DangerousCommandMatch = {
  rule: "recursive-permission-ownership-change",
  reason: "recursive chmod or chown against a high-risk target",
};
const DOWNLOAD_EXECUTION: DangerousCommandMatch = {
  rule: "download-and-execute",
  reason: "network download piped or redirected directly into a shell",
};
const PACKAGE_OPERATION: DangerousCommandMatch = {
  rule: "package-manager-high-impact-operation",
  reason: "package manager upgrade, uninstall, or global install operation",
};
const SERVICE_OPERATION: DangerousCommandMatch = {
  rule: "system-service-high-impact-operation",
  reason: "system service stop, disable, restart, or configuration operation",
};

const RISKY_TARGET = /^(?:\/|~(?:\/|$)|\*|\.\.(?:\/|$))/;
const RM_FLAGS = /^(?:-[A-Za-z]*[rRfF][A-Za-z]*|--recursive|--force)$/;
const RECURSIVE_FLAGS = /^(?:-[A-Za-z]*R[A-Za-z]*|--recursive)$/;
const PACKAGE_MANAGERS = new Set(["apt", "apt-get", "yum", "dnf", "brew", "npm", "pip", "pip3"]);
const PACKAGE_ACTIONS = new Set([
  "dist-upgrade",
  "full-upgrade",
  "upgrade",
  "remove",
  "purge",
  "autoremove",
]);
// update 等动作在不同管理器中含义不同，只在对应工具内归一化。
const PACKAGE_ACTION_ALIASES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  [
    "brew",
    new Map([
      ["remove", "uninstall"],
      ["rm", "uninstall"],
      ["uninstal", "uninstall"],
    ]),
  ],
  [
    "yum",
    new Map([
      ["update", "upgrade"],
      ["update-to", "upgrade"],
      ["upgrade-to", "upgrade"],
      ["localupdate", "upgrade"],
      ["erase", "remove"],
    ]),
  ],
  [
    "dnf",
    new Map([
      ["up", "upgrade"],
      ["update", "upgrade"],
      ["upgrade-to", "upgrade"],
      ["update-to", "upgrade"],
      ["localupdate", "upgrade"],
      ["rm", "remove"],
      ["erase", "remove"],
      ["remove-n", "remove"],
      ["remove-na", "remove"],
      ["remove-nevra", "remove"],
      ["erase-n", "remove"],
      ["erase-na", "remove"],
      ["erase-nevra", "remove"],
    ]),
  ],
]);
const SERVICE_ACTIONS = new Set([
  "start",
  "stop",
  "enable",
  "disable",
  "restart",
  "reload",
  "unload",
  "bootout",
  "remove",
]);
const PACKAGE_ZERO_OPTIONS = new Set([
  "-g",
  "--global",
  "--user",
  "--break-system-packages",
  "-y",
  "--yes",
  "-q",
  "--quiet",
  "--verbose",
]);
const SERVICE_ZERO_OPTIONS = new Set(["--user", "--system"]);
const NPM_ACTION_ALIASES: ReadonlyMap<string, "install" | "uninstall"> = new Map([
  ["install", "install"],
  ["add", "install"],
  ["i", "install"],
  ["in", "install"],
  ["ins", "install"],
  ["inst", "install"],
  ["insta", "install"],
  ["instal", "install"],
  ["isnt", "install"],
  ["isnta", "install"],
  ["isntal", "install"],
  ["isntall", "install"],
  ["install-test", "install"],
  ["installTest", "install"],
  ["it", "install"],
  ["uninstall", "uninstall"],
  ["unlink", "uninstall"],
  ["remove", "uninstall"],
  ["rm", "uninstall"],
  ["r", "uninstall"],
  ["un", "uninstall"],
]);

export function detectDangerousCommand(command: string): DangerousCommandMatch | undefined {
  return inspectCommand(command, false);
}

export function isDangerousCommand(command: string): boolean {
  return detectDangerousCommand(command) !== undefined;
}

function inspectCommand(command: string, insideShell: boolean): DangerousCommandMatch | undefined {
  const parsed = parseShellCommand(command);
  if (parsed.kind === "unsupported") return INDETERMINATE;
  const resolved = parsed.commands.map((segment) => resolveCommandPrefix(segment.words));
  let uncertain = false;

  for (let index = 0; index < resolved.length; index += 1) {
    const current = resolved[index];
    if (current.kind === "unsupported") {
      uncertain = true;
      continue;
    }
    const name = posix.basename(current.executable.value);
    const next = resolved[index + 1];
    if (
      (name === "curl" || name === "wget") &&
      parsed.commands[index].separator === "|" &&
      next?.kind === "parsed" &&
      isShellExecutable(next.executable.value)
    )
      return DOWNLOAD_EXECUTION;

    const match = isShellExecutable(current.executable.value)
      ? inspectShellBody(name, current.args, insideShell)
      : inspectSimpleCommand(name, current.args);
    if (match?.rule === INDETERMINATE.rule) uncertain = true;
    else if (match !== undefined) return match;
  }
  return uncertain ? INDETERMINATE : undefined;
}

function inspectShellBody(
  shell: string,
  args: readonly ShellWord[],
  insideShell: boolean,
): DangerousCommandMatch | undefined {
  if (
    insideShell ||
    !["sh", "bash", "zsh"].includes(shell) ||
    args[0]?.hasExpansion ||
    (args[0]?.value !== "-c" && args[0]?.value !== "-lc") ||
    args[1] === undefined ||
    args[1].hasExpansion
  )
    return INDETERMINATE;
  // 只展开一层已是字面量的 shell 命令体；不模拟变量或嵌套解释器。
  return inspectCommand(args[1].value, true);
}

function inspectSimpleCommand(
  name: string,
  args: readonly ShellWord[],
): DangerousCommandMatch | undefined {
  const values = args.map((word) => word.value);
  const dynamic = args.some((word) => word.hasExpansion);
  if (name === "rm" || name === "chmod" || name === "chown") {
    const flagPattern = name === "rm" ? RM_FLAGS : RECURSIVE_FLAGS;
    const endOptions = values.indexOf("--");
    const flags = endOptions < 0 ? values : values.slice(0, endOptions);
    if (
      flags.some((value) => flagPattern.test(value)) &&
      values.some((value) => RISKY_TARGET.test(normalizeRiskPath(value)))
    ) {
      return name === "rm" ? DESTRUCTIVE_RM : PERMISSION_CHANGE;
    }
    if (
      dynamic ||
      flags.some(
        (value) =>
          value.startsWith("--") && !["--recursive", "--force", "--verbose"].includes(value),
      )
    )
      return INDETERMINATE;
    return undefined;
  }
  if (/^mkfs(?:\.[\w-]+)?$/.test(name) || name === "fdisk" || name === "parted")
    return DISK_OPERATION;
  if (name === "dd") {
    if (
      values.some((value) => {
        if (!value.startsWith("of=")) return false;
        const target = normalizeRiskPath(value.slice(3));
        return target === "/dev" || target.startsWith("/dev/");
      })
    )
      return DISK_OPERATION;
    return dynamic ? INDETERMINATE : undefined;
  }
  if (name === "diskutil") {
    if (args[0]?.hasExpansion || values[0]?.startsWith("-")) return INDETERMINATE;
    return /^erase\w*$/.test(values[0] ?? "") ? DISK_OPERATION : undefined;
  }
  if (PACKAGE_MANAGERS.has(name)) return inspectPackageCommand(name, args);
  if (name === "service" || name === "systemctl" || name === "launchctl") {
    const action =
      name === "service" ? serviceAction(args) : leadingAction(args, SERVICE_ZERO_OPTIONS);
    if (action === null) return INDETERMINATE;
    return action !== undefined && SERVICE_ACTIONS.has(action) ? SERVICE_OPERATION : undefined;
  }
  return undefined;
}

function normalizeRiskPath(value: string): string {
  // 只整理分析副本的分隔符和点段；保留 ..，避免忽略符号链接的实际解析语义。
  const segments = value.split("/").filter((segment) => segment !== "" && segment !== ".");
  return (value.startsWith("/") ? "/" : "") + segments.join("/");
}

function inspectPackageCommand(
  name: string,
  args: readonly ShellWord[],
): DangerousCommandMatch | undefined {
  const parsedAction = leadingAction(args, PACKAGE_ZERO_OPTIONS);
  if (parsedAction === null) return INDETERMINATE;
  if (parsedAction === undefined) return undefined;
  const action =
    name === "npm"
      ? resolveNpmAction(parsedAction)
      : (PACKAGE_ACTION_ALIASES.get(name)?.get(parsedAction) ?? parsedAction);
  if (action === null) return INDETERMINATE;
  if (name === "brew")
    return ["upgrade", "uninstall"].includes(action) ? PACKAGE_OPERATION : undefined;
  if (name !== "npm" && name !== "pip" && name !== "pip3") {
    return PACKAGE_ACTIONS.has(action) ? PACKAGE_OPERATION : undefined;
  }
  if (!["install", "uninstall", "remove", "rm"].includes(action)) return undefined;
  const globalFlags =
    name === "npm" ? ["-g", "--global"] : ["-g", "--user", "--break-system-packages"];
  if (args.some((word) => globalFlags.includes(word.value))) return PACKAGE_OPERATION;
  return args.some(
    (word) =>
      word.hasExpansion ||
      (word.value.startsWith("-") && word.value !== "--" && !PACKAGE_ZERO_OPTIONS.has(word.value)),
  )
    ? INDETERMINATE
    : undefined;
}

function resolveNpmAction(action: string): string | null {
  const canonical = NPM_ACTION_ALIASES.get(action);
  if (canonical !== undefined) return canonical;
  // npm 也接受唯一前缀缩写；不复制完整命令表，相关前缀统一要求额外确认。
  for (const knownAction of NPM_ACTION_ALIASES.keys()) {
    if (knownAction.startsWith(action)) return null;
  }
  return action;
}

function serviceAction(args: readonly ShellWord[]): string | null | undefined {
  if (args[0]?.hasExpansion || args[0]?.value.startsWith("-")) return null;
  return args[1]?.hasExpansion || args[1]?.value.startsWith("-") ? null : args[1]?.value;
}

function leadingAction(
  args: readonly ShellWord[],
  zeroOptions: ReadonlySet<string>,
): string | null | undefined {
  for (const word of args) {
    if (word.hasExpansion) return null;
    if (zeroOptions.has(word.value) || word.value === "--") continue;
    return word.value.startsWith("-") ? null : word.value;
  }
  return undefined;
}
