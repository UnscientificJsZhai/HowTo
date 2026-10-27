import { UsageToolsUnsupportedError } from "../ai/errors.js";
import type {
  CommandCandidateContract,
  CommandProvider,
  GenerateCommandsRequest,
} from "../ai/types.js";
import { createUsageGenerationRequest } from "../prompt.js";
import { InteractionCancelledError } from "../ui/tty.js";
import { AiResponseValidationError } from "../validation/ai-response.js";
import { validateUseCommandCandidates } from "../validation/command-tool.js";
import { generateValidatedCommandCandidates } from "../validation/generated-commands.js";
import {
  parseAndValidateUsageResponse,
  UsageGenerationFailureError,
} from "../validation/usage-response.js";
import { validateUsageLookupArguments } from "./arguments.js";
import { resolveUsageCommandDanger } from "./risk.js";
import { sanitizeUsageLookupResult } from "./output.js";
import { createUsageLookupResult, executeUsageLookup, resolveUsageExecutable } from "./runner.js";
import type {
  UsageGenerationInteraction,
  UsageLookupResult,
  UsageToolCall,
  UsageToolReply,
} from "./types.js";

export const MAX_USAGE_LOOKUPS = 6;
export const USAGE_CAPABILITY_FALLBACK_NOTICE =
  "当前服务不支持此次原生用法查询；本次请求将保留已有信息，继续生成命令或说明无法生成的原因。";

export interface UsageGenerationDependencies {
  resolveExecutable?: typeof resolveUsageExecutable;
  executeLookup?: typeof executeUsageLookup;
}

export async function generateWithUsageLookup(
  provider: CommandProvider,
  request: GenerateCommandsRequest,
  interaction: UsageGenerationInteraction,
  signal: AbortSignal,
  dependencies: UsageGenerationDependencies = {},
): Promise<CommandCandidateContract[]> {
  if (request.useCommand === undefined || provider.createUsageSession === undefined) {
    return generateValidatedCommandCandidates(provider, request, signal);
  }
  const session = provider.createUsageSession(createUsageGenerationRequest(request));
  const commandName = request.useCommand;
  // 本次请求只解析一次；审批期间 PATH 或符号链接变化不会替换已展示的程序路径。
  const executable = (dependencies.resolveExecutable ?? resolveUsageExecutable)(request.useCommand);
  const execute = dependencies.executeLookup ?? executeUsageLookup;
  const cache = new Map<string, UsageLookupResult>();
  let handled = 0;
  let degraded = false;
  let replies: UsageToolReply[] = [];
  const credentials = () => [
    ...(interaction.knownCredentials ?? []),
    ...(session.getKnownCredentials?.() ?? []),
  ];

  for (;;) {
    checkCancelled(signal);
    const toolsEnabled =
      !degraded && handled < MAX_USAGE_LOOKUPS && interaction.getExecutionPolicy() === "execute";
    let turn;
    try {
      turn = await session.next(replies, { toolsEnabled }, signal);
    } catch (error) {
      checkCancelled(signal);
      if (toolsEnabled && !degraded && error instanceof UsageToolsUnsupportedError) {
        degraded = true;
        interaction.onCapabilityFallback?.(USAGE_CAPABILITY_FALLBACK_NOTICE);
        continue;
      }
      throw error;
    }
    checkCancelled(signal);
    if (turn.kind === "final") {
      try {
        const response = parseAndValidateUsageResponse(turn.rawText);
        validateUseCommandCandidates(response, request.useCommand);
        return response.commands;
      } catch (error) {
        if (error instanceof UsageGenerationFailureError) {
          // 明确失败也可能复述工具输出中的已知凭据，显示前统一脱敏。
          const safe = sanitizeUsageLookupResult(
            { ...createUsageLookupResult(null, "success"), stdout: error.message },
            credentials(),
          );
          throw new UsageGenerationFailureError(safe.stdout);
        }
        throw error;
      }
    }
    if (!toolsEnabled) {
      throw new UsageGenerationFailureError("查询已关闭，AI 未能提供可靠的最终命令。");
    }
    if (turn.calls.length === 0) {
      throw new AiResponseValidationError("usage tool response must contain at least one call");
    }
    replies = [];
    for (const call of turn.calls) {
      checkCancelled(signal);
      const result =
        handled >= MAX_USAGE_LOOKUPS
          ? createUsageLookupResult(call.arguments, "budget_exhausted")
          : await handleCall(call);
      replies.push({ callId: call.id, result: sanitizeUsageLookupResult(result, credentials()) });
    }
  }

  async function handleCall(call: UsageToolCall): Promise<UsageLookupResult> {
    handled++;
    let lookup;
    try {
      if (call.name !== "lookup_command_usage") throw new Error("invalid tool");
      lookup = validateUsageLookupArguments(call.arguments);
    } catch {
      return createUsageLookupResult(call.arguments, "invalid_arguments");
    }
    const key = JSON.stringify(lookup.args);
    const cached = cache.get(key);
    if (cached !== undefined) return { ...cached, requested: call.arguments };
    const remember = (result: UsageLookupResult): UsageLookupResult => {
      cache.set(key, result);
      return result;
    };
    if (interaction.getExecutionPolicy() !== "execute") {
      return remember(createUsageLookupResult(call.arguments, "permission_revoked"));
    }
    if (executable === null) {
      return remember(createUsageLookupResult(call.arguments, "not_found"));
    }
    const decision = await interaction.approve(
      {
        commandName,
        executable,
        lookup,
        danger: resolveUsageCommandDanger(commandName, executable, lookup.args, lookup),
        knownCredentials: credentials(),
      },
      signal,
    );
    checkCancelled(signal);
    if (interaction.getExecutionPolicy() !== "execute") {
      return remember(createUsageLookupResult(call.arguments, "permission_revoked"));
    }
    if (decision.kind === "reject") {
      return remember(createUsageLookupResult(call.arguments, "rejected"));
    }
    // 即使 UI 有漏洞或宿主回调被替换，非法编辑仍不能进入执行器。
    let edited;
    try {
      edited = validateUsageLookupArguments({ ...lookup, args: decision.args });
    } catch {
      return remember(createUsageLookupResult(call.arguments, "invalid_arguments"));
    }
    interaction.onQueryRunning?.({
      executable,
      args: edited.args,
      knownCredentials: credentials(),
    });
    try {
      const result = await execute({
        requested: call.arguments,
        executable,
        argv0: commandName,
        args: edited.args,
        signal,
        getExecutionPolicy: () => interaction.getExecutionPolicy(),
        checkExecutionPolicy: () =>
          interaction.checkExecutionPolicy?.() ?? interaction.getExecutionPolicy(),
        subscribeExecutionPolicy: (listener) => interaction.subscribeExecutionPolicy(listener),
        knownCredentials: credentials(),
      });
      checkCancelled(signal);
      remember(result);
      if (result.actualCommand !== null) cache.set(JSON.stringify(edited.args), result);
      return result;
    } finally {
      interaction.onQueryRunning?.(null);
    }
  }
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new InteractionCancelledError();
}
