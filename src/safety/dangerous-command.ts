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
const LINUX_PACKAGE_ACTIONS = new Map([
  ["apk", new Set(["add", "del", "fix", "upgrade"])],
  [
    "zypper",
    new Set([
      "install",
      "in",
      "remove",
      "rm",
      "update",
      "up",
      "dist-upgrade",
      "dup",
      "patch",
      "verify",
      "ve",
      "install-new-recommends",
      "inr",
    ]),
  ],
]);
const LINUX_PACKAGE_QUERIES = new Map([
  ["apk", new Set(["search", "info", "list", "policy", "version", "stats", "audit", "update"])],
  [
    "zypper",
    new Set([
      "search",
      "se",
      "info",
      "if",
      "list-updates",
      "lu",
      "list-patches",
      "lp",
      "packages",
      "pa",
      "repos",
      "lr",
      "refresh",
      "ref",
      "help",
    ]),
  ],
]);
const LINUX_PACKAGE_ZERO_OPTIONS = new Map([
  ["apk", new Set(["-q", "--quiet", "-v", "--verbose", "--no-cache", "--no-progress"])],
  [
    "zypper",
    new Set(["-q", "--quiet", "-v", "--verbose", "-n", "--non-interactive", "--no-refresh"]),
  ],
]);
const PACMAN_LONG_OPTIONS = new Map([
  ["--query", "Q"],
  ["--files", "F"],
  ["--deptest", "T"],
  ["--remove", "R"],
  ["--sync", "S"],
  ["--upgrade", "U"],
  ["--database", "D"],
  ["--help", "h"],
  ["--version", "V"],
  ["--search", "s"],
  ["--info", "i"],
  ["--list", "l"],
  ["--groups", "g"],
  ["--quiet", "q"],
  ["--sysupgrade", "u"],
  ["--refresh", "y"],
  // 不复用其他操作的查询短选项语义。
  ["--recursive", "recursive"],
  ["--nosave", "nosave"],
  ["--clean", "clean"],
  ["--print", "p"],
  ["--noconfirm", ""],
  ["--confirm", ""],
]);
const PACMAN_OPERATIONS = new Set("DFQRSTUVh");
const PACMAN_SHORT_OPTIONS = new Set("DFQRSTUVhcdegiklmnopqstuvwyx");
const RC_SERVICE_ZERO_OPTIONS = new Set([
  "-c",
  "--ifcrashed",
  "-d",
  "--debug",
  "-D",
  "--nodeps",
  "-i",
  "--ifexists",
  "-I",
  "--ifinactive",
  "-N",
  "--ifnotstarted",
  "-s",
  "--ifstarted",
  "-S",
  "--ifstopped",
  "-q",
  "--quiet",
  "-v",
  "--verbose",
]);
const RC_UPDATE_ZERO_OPTIONS = new Set(["-s", "--stack", "-a", "--all", "-v", "--verbose"]);
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
  // BusyBox 根据首个参数再分派工具；未分析 applet 前不能将其判为普通安全命令。
  if (name === "busybox") return INDETERMINATE;
  if (name === "apk" || name === "zypper") return inspectLinuxPackageCommand(name, args);
  if (name === "pacman") return inspectPacmanCommand(args);
  if (name === "rc-service" || name === "rc-update") return inspectOpenRcCommand(name, args);
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

function inspectLinuxPackageCommand(
  name: string,
  args: readonly ShellWord[],
): DangerousCommandMatch | undefined {
  const zeroOptions = LINUX_PACKAGE_ZERO_OPTIONS.get(name) ?? new Set<string>();
  const action = leadingAction(args, zeroOptions);
  if (action === null) return INDETERMINATE;
  if (action === undefined) return undefined;
  if (LINUX_PACKAGE_ACTIONS.get(name)?.has(action)) return PACKAGE_OPERATION;
  if (!LINUX_PACKAGE_QUERIES.get(name)?.has(action)) return INDETERMINATE;
  // 查询也可能通过选项写文件（如 zypper repos --export），仅放行已知无参数选项。
  return args.some(
    (word) =>
      word.hasExpansion ||
      (word.value.startsWith("-") && word.value !== "--" && !zeroOptions.has(word.value)),
  )
    ? INDETERMINATE
    : undefined;
}

function inspectPacmanCommand(args: readonly ShellWord[]): DangerousCommandMatch | undefined {
  const flags: string[] = [];
  let optionsEnded = false;
  for (const word of args) {
    if (word.hasExpansion) return INDETERMINATE;
    const value = word.value;
    if (optionsEnded) continue;
    if (value === "--") {
      optionsEnded = true;
    } else if (value.startsWith("--")) {
      const flag = PACMAN_LONG_OPTIONS.get(value);
      // 不猜测未知选项的参数个数，防止把 --config 等选项的值误当查询开关。
      if (flag === undefined) return INDETERMINATE;
      if (flag !== "") flags.push(flag);
    } else if (value.startsWith("-") && value !== "-") {
      const shortFlags = [...value.slice(1)];
      if (shortFlags.some((flag) => !PACMAN_SHORT_OPTIONS.has(flag))) return INDETERMINATE;
      flags.push(...shortFlags);
    }
  }
  const operations = flags.filter((flag) => PACMAN_OPERATIONS.has(flag));
  if (operations.length !== 1) return INDETERMINATE;
  const operation = operations[0];
  const options = flags.filter((flag) => !PACMAN_OPERATIONS.has(flag));
  if (operation === "R" || operation === "U" || operation === "D") return PACKAGE_OPERATION;
  if (operation === "S") {
    // 只明确放行纯查询组合；升级、安装、缓存清理和混合选项仍需确认。
    return options.some((flag) => "silgp".includes(flag)) &&
      options.every((flag) => "silgpq".includes(flag))
      ? undefined
      : PACKAGE_OPERATION;
  }
  const queryOptions = operation === "Q" ? "cdegiklmnopqstu" : operation === "F" ? "lqx" : "";
  return options.every((flag) => queryOptions.includes(flag)) ? undefined : INDETERMINATE;
}

function inspectOpenRcCommand(
  name: string,
  args: readonly ShellWord[],
): DangerousCommandMatch | undefined {
  if (name === "rc-update") {
    const action = leadingAction(args, RC_UPDATE_ZERO_OPTIONS);
    if (action === null) return INDETERMINATE;
    if (action === "add" || action === "del" || action === "delete") return SERVICE_OPERATION;
    if (action !== undefined && action !== "show") return INDETERMINATE;
    return args.some(
      (word) =>
        word.hasExpansion ||
        (word.value.startsWith("-") &&
          word.value !== "--" &&
          !RC_UPDATE_ZERO_OPTIONS.has(word.value)),
    )
      ? INDETERMINATE
      : undefined;
  }
  if (
    args.length === 1 &&
    !args[0].hasExpansion &&
    ["-l", "--list", "-h", "--help"].includes(args[0].value)
  )
    return undefined;
  if (
    args.length === 2 &&
    !args.some((word) => word.hasExpansion) &&
    ["-e", "--exists", "-r", "--resolve"].includes(args[0].value) &&
    !args[1].value.startsWith("-")
  )
    return undefined;
  let index = 0;
  while (args[index] && !args[index].hasExpansion && RC_SERVICE_ZERO_OPTIONS.has(args[index].value))
    index++;
  const action = serviceAction(args.slice(index));
  if (action === null) return INDETERMINATE;
  if (action !== undefined && (SERVICE_ACTIONS.has(action) || action === "zap"))
    return SERVICE_OPERATION;
  // OpenRC 会把剩余参数传给服务脚本；status 后仍有命令时不能按只读查询放行。
  return args.length === index + 2 && (action === "status" || action === "describe")
    ? undefined
    : INDETERMINATE;
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
