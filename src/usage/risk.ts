import { detectDangerousCommand, type DangerousCommandMatch } from "../safety/dangerous-command.js";
import { formatUsageCommand } from "./arguments.js";
import type { UsageLookupArguments } from "./types.js";

/** 符号链接可能改变 basename；原调用名与真实程序任一风险都不能被另一者覆盖。 */
export function resolveUsageCommandDanger(
  commandName: string,
  executable: string,
  args: readonly string[],
  lookup: Pick<UsageLookupArguments, "dangerous" | "dangerReason">,
): DangerousCommandMatch | undefined {
  const named = detectDangerousCommand(formatUsageCommand(commandName, args));
  const resolved = detectDangerousCommand(formatUsageCommand(executable, args));
  const local = named ?? resolved;
  const reasons = new Set(
    [named?.reason, resolved?.reason].filter((reason) => reason !== undefined),
  );
  if (lookup.dangerous) reasons.add(`AI: ${lookup.dangerReason}`);
  if (local === undefined && !lookup.dangerous) return undefined;
  return {
    rule: local?.rule ?? "ai-flagged-dangerous-command",
    reason: [...reasons].join("; "),
  };
}
