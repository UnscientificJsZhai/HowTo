import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useWindowSize, type Key } from "ink";
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
import { detectDangerousCommand, type DangerousCommandMatch } from "../safety/dangerous-command.js";
import { resolveCandidatePlaceholders, type ResolvedCommand } from "./placeholder-logic.js";
import { InteractionCancelledError } from "./tty.js";
import { usePhysicalStdoutRows } from "./resize-safe-output.js";

type Status = "loading" | "selecting" | "resolving" | "confirming" | "error" | "done";

interface Props {
  provider: CommandProvider;
  request: GenerateCommandsRequest;
  onSuccess: (command: string) => void;
  onError: (error: Error) => void;
}

export const App: React.FC<Props> = ({ provider, request, onSuccess, onError }) => {
  const rows = usePhysicalStdoutRows();
  const { columns } = useWindowSize();
  const [status, setStatus] = useState<Status>("loading");
  const [candidates, setCandidates] = useState<CommandCandidateContract[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CommandCandidateContract | null>(null);
  const [resolvedValues, setResolvedValues] = useState<Map<string, string>>(new Map());
  const [finalCommand, setFinalCommand] = useState("");
  const [danger, setDanger] = useState<DangerousCommandMatch | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState("");
  const frameRows = Math.max(0, rows - 1);
  const isFrameVisible = frameRows > 0;

  const handleCancel = () => {
    onError(new InteractionCancelledError());
  };

  useInput((input: string, key: Key) => {
    if (frameRows === 0) return;
    if (status !== "loading") return;

    if (key.ctrl && input === "c") {
      handleCancel();
    }
  });

  useEffect(() => {
    if (status === "loading") {
      generateValidatedCommandCandidates(provider, request)
        .then((generatedCandidates) => {
          setCandidates(generatedCandidates);
          setStatus("selecting");
        })
        .catch((error: unknown) => {
          const appError = normalizeError(error);
          setErrorMessage(appError.message);
          setStatus("error");
          onError(appError);
        });
    }
  }, [status, provider, request, onError]);

  const handleSelect = (candidate: CommandCandidateContract) => {
    setSelectedCandidate(candidate);
    setResolvedValues(new Map());
    if (candidate.placeholders.length > 0) {
      setStatus("resolving");
    } else {
      try {
        const resolved = resolveCandidatePlaceholders(candidate, new Map());
        setFinalCommand(resolved.command);
        setResolvedValues(resolved.values);
        setDanger(detectDangerousCommand(resolved.command));
        setStatus("confirming");
      } catch (error: unknown) {
        const appError = normalizeError(error);
        setErrorMessage(appError.message);
        setStatus("error");
        onError(appError);
      }
    }
  };

  const handleResolve = (resolved: ResolvedCommand) => {
    if (!selectedCandidate) return;
    setResolvedValues(resolved.values);
    setFinalCommand(resolved.command);
    setDanger(detectDangerousCommand(resolved.command));
    setStatus("confirming");
  };

  useEffect(() => {
    if (status === "done") {
      onSuccess(finalCommand);
    }
  }, [status, finalCommand, onSuccess]);

  const handleConfirm = () => {
    setStatus("done");
  };

  const handleBackToSelection = () => {
    setStatus("selecting");
  };

  return (
    <Box
      flexDirection="column"
      display={isFrameVisible ? "flex" : "none"}
      maxHeight={frameRows}
      overflowY="hidden"
    >
      {status === "loading" && <LoadingView />}
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
