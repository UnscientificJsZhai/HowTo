export interface DangerousCommandMatch {
  rule: string;
  reason: string;
}

interface DangerousCommandRule {
  name: string;
  reason: string;
  matches(command: string): boolean;
}

const SHELL_COMMAND_PREFIX = String.raw`(?:^|[;&|]\s*|\|\s*)`;
const SUDO_PREFIX = String.raw`(?:sudo\s+)?`;
const COMMAND_PREFIX = `${SHELL_COMMAND_PREFIX}${SUDO_PREFIX}`;
const RISKY_TARGET_PATTERN = /(^|\s)(?:\/|~(?:\/|\s|$)|\*|\.\.\/|\.\/\*|\/(?:bin|boot|dev|etc|home|lib|opt|private|sbin|System|usr|var)(?:\/|\s|$))/;

const RULES: DangerousCommandRule[] = [
  {
    name: "destructive-rm",
    reason: "recursive or forced rm against a high-risk target",
    matches(command) {
      return findCommandSegments(command, "rm").some((segment) => {
        const hasDangerousFlag = /(^|\s)(?:-[A-Za-z]*[rRfF][A-Za-z]*|--recursive|--force)(\s|$)/.test(segment);
        return hasDangerousFlag && RISKY_TARGET_PATTERN.test(segment);
      });
    },
  },
  {
    name: "disk-filesystem-operation",
    reason: "disk, partition, filesystem, or raw block-device operation",
    matches(command) {
      return (
        new RegExp(`${COMMAND_PREFIX}(?:mkfs(?:\\.[\\w-]+)?|fdisk|parted)(?:\\s|$)`).test(command) ||
        new RegExp(`${COMMAND_PREFIX}diskutil\\s+erase\\w*\\b`).test(command) ||
        new RegExp(`${COMMAND_PREFIX}dd\\s+[^;&|]*\\bif=\\S+\\s+[^;&|]*\\bof=/dev/\\S*`).test(command)
      );
    },
  },
  {
    name: "recursive-permission-ownership-change",
    reason: "recursive chmod or chown against a high-risk target",
    matches(command) {
      return findCommandSegments(command, "(?:chmod|chown)").some((segment) => {
        const hasRecursiveFlag = /(^|\s)(?:-[A-Za-z]*R[A-Za-z]*|--recursive)(\s|$)/.test(segment);
        return hasRecursiveFlag && RISKY_TARGET_PATTERN.test(segment);
      });
    },
  },
  {
    name: "download-and-execute",
    reason: "network download piped or redirected directly into a shell",
    matches(command) {
      return (
        /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(command) ||
        /\b(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)\b/.test(command) ||
        /\bwget\b[^|;&]*\s+-O-\s*\|\s*(?:sudo\s+)?(?:sh|bash|zsh)\b/.test(command)
      );
    },
  },
  {
    name: "package-manager-high-impact-operation",
    reason: "package manager upgrade, uninstall, or global install operation",
    matches(command) {
      return (
        new RegExp(`${COMMAND_PREFIX}(?:apt|apt-get|yum|dnf)\\s+(?:dist-upgrade|full-upgrade|upgrade|remove|purge|autoremove)\\b`).test(command) ||
        new RegExp(`${COMMAND_PREFIX}brew\\s+(?:upgrade|uninstall|remove)\\b`).test(command) ||
        new RegExp(`${COMMAND_PREFIX}npm\\s+(?:install|uninstall|remove|rm)\\b[^;&|]*(?:^|\\s)(?:-g|--global)(?:\\s|$)`).test(command) ||
        new RegExp(`${COMMAND_PREFIX}(?:pip|pip3)\\s+(?:install|uninstall)\\b[^;&|]*(?:^|\\s)(?:-g|--user|--break-system-packages)(?:\\s|$)`).test(command)
      );
    },
  },
  {
    name: "system-service-high-impact-operation",
    reason: "system service stop, disable, restart, or configuration operation",
    matches(command) {
      return new RegExp(
        `${COMMAND_PREFIX}(?:systemctl|service|launchctl)\\s+(?:stop|disable|restart|reload|unload|bootout|remove)\\b`,
      ).test(command);
    },
  },
];

export function detectDangerousCommand(command: string): DangerousCommandMatch | undefined {
  const normalizedCommand = normalizeCommand(command);
  const commandsToCheck = [normalizedCommand, ...extractSudoShellCommands(normalizedCommand)];

  for (const commandToCheck of commandsToCheck) {
    for (const rule of RULES) {
      if (rule.matches(commandToCheck)) {
        return {
          rule: rule.name,
          reason: rule.reason,
        };
      }
    }
  }

  return undefined;
}

export function isDangerousCommand(command: string): boolean {
  return detectDangerousCommand(command) !== undefined;
}

function normalizeCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function extractSudoShellCommands(command: string): string[] {
  const matcher = /\bsudo\s+(?:sh|bash|zsh)\s+-c\s+(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  const commands: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(command)) !== null) {
    const shellCommand = match[1] ?? match[2] ?? match[3];

    if (shellCommand !== undefined) {
      commands.push(normalizeCommand(shellCommand));
    }
  }

  return commands;
}

function findCommandSegments(command: string, commandNamePattern: string): string[] {
  const matcher = new RegExp(`${COMMAND_PREFIX}${commandNamePattern}\\b([^;&|]*)`, "g");
  const segments: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(command)) !== null) {
    segments.push(match[0]);
  }

  return segments;
}
