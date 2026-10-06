import type { CommandCandidateContract } from "../ai/types.js";
import { detectDangerousCommand, type DangerousCommandMatch } from "./dangerous-command.js";

export function resolveCommandDanger(
  finalCommand: string,
  candidate: Pick<CommandCandidateContract, "dangerous" | "dangerReason">,
): DangerousCommandMatch | undefined {
  // 始终检查最终命令；AI 的否定结果不能降低静态规则的确认要求。
  const localDanger = detectDangerousCommand(finalCommand);
  if (!candidate.dangerous) return localDanger;

  const aiReason = `AI: ${candidate.dangerReason}`;
  return localDanger === undefined
    ? { rule: "ai-flagged-dangerous-command", reason: aiReason }
    : { ...localDanger, reason: `${localDanger.reason}; ${aiReason}` };
}
