import type { DangerousCommandMatch } from "../safety/dangerous-command.js";

export interface UsageLookupArguments {
  args: string[];
  purpose: string;
  dangerous: boolean;
  dangerReason: string;
}

export interface UsageToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type UsageLookupStatus =
  | "success"
  | "rejected"
  | "invalid_arguments"
  | "not_found"
  | "spawn_failed"
  | "nonzero_exit"
  | "timeout"
  | "cancelled"
  | "permission_revoked"
  | "budget_exhausted";

export interface UsageLookupResult {
  requested: unknown;
  actualCommand: { executable: string; args: string[]; argv0?: string } | null;
  status: UsageLookupStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  credentialsRedacted: boolean;
}

export interface UsageToolReply {
  callId: string;
  result: UsageLookupResult;
}

export type UsageSessionTurn =
  { kind: "tool_calls"; calls: UsageToolCall[] } | { kind: "final"; rawText: string };

export interface UsageGenerationSession {
  getKnownCredentials?(): readonly string[];
  next(
    replies: UsageToolReply[],
    options: { toolsEnabled: boolean },
    signal?: AbortSignal,
  ): Promise<UsageSessionTurn>;
}

export interface UsageApprovalRequest {
  commandName: string;
  executable: string;
  lookup: UsageLookupArguments;
  danger?: DangerousCommandMatch;
  knownCredentials?: readonly string[];
}

export type UsageApprovalDecision = { kind: "approve"; args: string[] } | { kind: "reject" };

export interface UsageGenerationInteraction {
  approve(request: UsageApprovalRequest, signal: AbortSignal): Promise<UsageApprovalDecision>;
  getExecutionPolicy(): "execute" | "print";
  /** 仅在查询启动前同步排空并检查输入；普通网络轮次与审批只读取权限。 */
  checkExecutionPolicy?(): "execute" | "print";
  subscribeExecutionPolicy(listener: () => void): () => void;
  onQueryRunning?(
    command: {
      executable: string;
      args: string[];
      knownCredentials: readonly string[];
    } | null,
  ): void;
  onCapabilityFallback?(message: string): void;
  knownCredentials?: readonly string[];
}
