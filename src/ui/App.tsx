import React, { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import { Box, Text, usePaste, useStderr, useWindowSize, type Key } from "ink";
import { useKeyboardInput } from "./use-keyboard-input.js";
import { useInteractiveSession } from "./InteractiveSessionProvider.js";
import { LoadingView } from "./LoadingView.js";
import { SelectCommandView } from "./SelectCommandView.js";
import { ResolvePlaceholdersView } from "./ResolvePlaceholdersView.js";
import { ConfirmView } from "./ConfirmView.js";
import type {
  CommandCandidateContract,
  CommandProvider,
  GenerateCommandsRequest,
} from "../ai/types.js";
import { generateValidatedCommandCandidates } from "../validation/generated-commands.js";
import type { DangerousCommandMatch } from "../safety/dangerous-command.js";
import { resolveCommandDanger } from "../safety/command-risk.js";
import { resolveCandidatePlaceholders, type ResolvedCommand } from "./placeholder-logic.js";
import { InteractionCancelledError } from "./tty.js";
import { usePhysicalStdoutRows } from "./resize-safe-output.js";
import { getUserVisibleErrorMessage } from "../errors.js";
import { generateWithUsageLookup } from "../usage/generate.js";
import type { UsageApprovalDecision, UsageApprovalRequest } from "../usage/types.js";
import { formatUsageCommand } from "../usage/arguments.js";
import { sanitizeUsageText } from "../usage/output.js";
import { UsageApprovalView } from "./UsageApprovalView.js";
import { toSingleLinePreview } from "./single-line-preview.js";

type Status =
  | "loading"
  | "usage-approval"
  | "usage-running"
  | "selecting"
  | "resolving"
  | "confirming"
  | "error"
  | "done";

interface Props {
  provider: CommandProvider;
  request: GenerateCommandsRequest;
  onSuccess: (command: string) => void;
  onError: (error: Error) => void;
  knownCredentials?: readonly string[];
}

export const App: React.FC<Props> = ({
  provider,
  request,
  onSuccess,
  onError,
  knownCredentials = [],
}) => {
  const session = useInteractiveSession();
  const rows = usePhysicalStdoutRows();
  const { columns } = useWindowSize();
  const { write: writeStderr } = useStderr();
  const writeStderrRef = useRef(writeStderr);
  writeStderrRef.current = writeStderr;
  const [status, setStatus] = useState<Status>("loading");
  const [candidates, setCandidates] = useState<CommandCandidateContract[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CommandCandidateContract | null>(null);
  const [resolvedValues, setResolvedValues] = useState<Map<string, string>>(new Map());
  const [finalCommand, setFinalCommand] = useState("");
  const [danger, setDanger] = useState<DangerousCommandMatch | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState("");
  const [usageApproval, setUsageApproval] = useState<UsageApprovalRequest | null>(null);
  const [runningQuery, setRunningQuery] = useState("");
  const approvalSequence = useRef(0);
  const pendingApproval = useRef<((decision: UsageApprovalDecision) => void) | null>(null);
  const onErrorRef = useRef(onError);
  const credentialsRef = useRef(knownCredentials);
  onErrorRef.current = onError;
  credentialsRef.current = knownCredentials;
  const activeRequestControllerRef = useRef<AbortController | null>(null);
  const cancellationReportedRef = useRef(false);
  const frameRows = Math.max(0, rows - 1);
  const isFrameVisible = frameRows > 0;

  usePaste(
    () => {
      if (status === "resolving" || status === "usage-approval" || status === "confirming") return;
      if (session.isInputCurrent()) session.reportIgnoredPaste();
      else session.reportStalePaste();
    },
    { isActive: isFrameVisible },
  );

  useLayoutEffect(() => {
    if (status !== "done" && status !== "error" && status !== "usage-approval")
      return session.beginView();
  }, [session, status]);

  const handleCancel = useCallback(() => {
    session.suspendViewInput();
    activeRequestControllerRef.current?.abort();
    if (cancellationReportedRef.current) return;

    cancellationReportedRef.current = true;
    onError(new InteractionCancelledError());
  }, [onError, session]);

  const inputReady = useKeyboardInput((input: string, key: Key) => {
    if (frameRows === 0) return;
    if (status !== "loading" && status !== "usage-running") return;

    if (key.ctrl && input === "c") {
      handleCancel();
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    let isCurrent = true;
    activeRequestControllerRef.current = controller;

    const approve = (approval: UsageApprovalRequest, signal: AbortSignal) => {
      if (signal.aborted || session.checkExecutionPolicy() !== "execute") {
        return Promise.resolve<UsageApprovalDecision>({ kind: "reject" });
      }
      return new Promise<UsageApprovalDecision>((resolve) => {
        let settled = false;
        const finish = (decision: UsageApprovalDecision) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", reject);
          unsubscribe();
          pendingApproval.current = null;
          session.suspendViewInput();
          if (isCurrent && !controller.signal.aborted) {
            setUsageApproval(null);
            setStatus("loading");
          }
          resolve(decision);
        };
        const reject = () => finish({ kind: "reject" });
        const unsubscribe = session.subscribeExecutionPolicy(() => {
          if (session.getExecutionPolicy() !== "execute") reject();
        });
        signal.addEventListener("abort", reject, { once: true });
        pendingApproval.current = finish;
        session.suspendViewInput();
        if (settled) return;
        approvalSequence.current++;
        setUsageApproval(approval);
        setStatus("usage-approval");
      });
    };
    const generation =
      request.useCommand !== undefined && provider.createUsageSession !== undefined
        ? generateWithUsageLookup(
            provider,
            request,
            {
              approve,
              getExecutionPolicy: session.checkExecutionPolicy,
              subscribeExecutionPolicy: session.subscribeExecutionPolicy,
              knownCredentials: credentialsRef.current,
              onQueryRunning: (command) => {
                if (!isCurrent || controller.signal.aborted) return;
                session.suspendViewInput();
                setRunningQuery(
                  command === null ? "" : formatUsageCommand(command.executable, command.args),
                );
                setStatus(command === null ? "loading" : "usage-running");
              },
              onCapabilityFallback: (message) => {
                // Ink 的输出入口先清理当前帧再恢复，完整提示在紧凑终端中仍进入可查看的滚动历史。
                if (isCurrent && !controller.signal.aborted) writeStderrRef.current(`${message}\n`);
              },
            },
            controller.signal,
          )
        : generateValidatedCommandCandidates(provider, request, controller.signal);

    void generation
      .then((generatedCandidates) => {
        if (!isCurrent || controller.signal.aborted) return;

        setCandidates(generatedCandidates);
        setStatus("selecting");
      })
      .catch((error: unknown) => {
        if (!isCurrent || controller.signal.aborted) return;

        const appError = normalizeError(error);
        setErrorMessage(getUserVisibleErrorMessage(appError));
        setStatus("error");
        onErrorRef.current(appError);
      });

    return () => {
      isCurrent = false;
      controller.abort();
      if (activeRequestControllerRef.current === controller) {
        activeRequestControllerRef.current = null;
      }
    };
  }, [provider, request, session]);

  const handleSelect = (candidate: CommandCandidateContract) => {
    session.suspendViewInput();
    setSelectedCandidate(candidate);
    setResolvedValues(new Map());
    if (candidate.placeholders.length > 0) {
      setStatus("resolving");
    } else {
      try {
        const resolved = resolveCandidatePlaceholders(candidate, new Map());
        setFinalCommand(resolved.command);
        setResolvedValues(resolved.values);
        setDanger(resolveCommandDanger(resolved.command, candidate));
        setStatus("confirming");
      } catch (error: unknown) {
        const appError = normalizeError(error);
        setErrorMessage(getUserVisibleErrorMessage(appError));
        setStatus("error");
        onError(appError);
      }
    }
  };

  const handleResolve = (resolved: ResolvedCommand) => {
    if (!selectedCandidate) return;
    session.suspendViewInput();
    setResolvedValues(resolved.values);
    setFinalCommand(resolved.command);
    setDanger(resolveCommandDanger(resolved.command, selectedCandidate));
    setStatus("confirming");
  };

  useEffect(() => {
    if (status === "done") {
      onSuccess(finalCommand);
    }
  }, [status, finalCommand, onSuccess]);

  const handleConfirm = () => {
    session.suspendViewInput();
    setStatus("done");
  };

  const handleBackToSelection = () => {
    session.suspendViewInput();
    setStatus("selecting");
  };

  return (
    <Box
      flexDirection="column"
      display={isFrameVisible && inputReady ? "flex" : "none"}
      maxHeight={frameRows}
      overflowY="hidden"
    >
      {status === "loading" && <LoadingView />}
      {status === "usage-approval" && usageApproval && (
        <UsageApprovalView
          key={approvalSequence.current}
          request={usageApproval}
          knownCredentials={knownCredentials}
          availableRows={frameRows}
          availableColumns={columns}
          onApprove={(args) => pendingApproval.current?.({ kind: "approve", args })}
          onReject={() => pendingApproval.current?.({ kind: "reject" })}
          onCancel={handleCancel}
        />
      )}
      {status === "usage-running" && (
        <Text wrap="truncate-middle">
          查询运行中（Ctrl+C取消）:{" "}
          {toSingleLinePreview(sanitizeUsageText(runningQuery, knownCredentials).text)}
        </Text>
      )}
      {status === "selecting" && (
        <SelectCommandView
          candidates={candidates}
          availableRows={frameRows}
          isInputActive={isFrameVisible}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      )}
      {status === "resolving" && selectedCandidate && (
        <ResolvePlaceholdersView
          candidate={selectedCandidate}
          availableRows={frameRows}
          availableColumns={columns}
          isInputActive={isFrameVisible}
          onResolve={handleResolve}
          onBack={handleBackToSelection}
          onCancel={handleCancel}
        />
      )}
      {(status === "confirming" || status === "done") && selectedCandidate && (
        <ConfirmView
          candidate={selectedCandidate}
          command={finalCommand}
          resolvedValues={resolvedValues}
          danger={danger}
          availableRows={frameRows}
          availableColumns={columns}
          isInputActive={isFrameVisible}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
          isDone={status === "done"}
        />
      )}
      {status === "error" && <Text color="red">Error: {errorMessage}</Text>}
    </Box>
  );
};

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.trim() !== "") {
    return new Error(error);
  }

  return new Error("unknown error");
}
