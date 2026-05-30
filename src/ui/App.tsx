import React, { useState, useEffect } from "react";
import { Box, Text, useWindowSize } from "ink";
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
import { replaceCommandPlaceholders } from "./placeholder-logic.js";
import { InteractionCancelledError } from "./tty.js";

type Status = "loading" | "selecting" | "resolving" | "confirming" | "error" | "done";

interface Props {
  provider: CommandProvider;
  request: GenerateCommandsRequest;
  onSuccess: (command: string) => void;
  onError: (error: Error) => void;
}

export const App: React.FC<Props> = ({ provider, request, onSuccess, onError }) => {
  const { rows } = useWindowSize();
  const [status, setStatus] = useState<Status>("loading");
  const [candidates, setCandidates] = useState<CommandCandidateContract[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CommandCandidateContract | null>(null);
  const [resolvedValues, setResolvedValues] = useState<Map<string, string>>(new Map());
  const [finalCommand, setFinalCommand] = useState("");
  const [danger, setDanger] = useState<DangerousCommandMatch | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState("");

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
      const command = candidate.command;
      setFinalCommand(command);
      setDanger(detectDangerousCommand(command));
      setStatus("confirming");
    }
  };

  const handleResolve = (values: Map<string, string>) => {
    if (!selectedCandidate) return;
    setResolvedValues(values);
    const command = replaceCommandPlaceholders(selectedCandidate.command, values);
    setFinalCommand(command);
    setDanger(detectDangerousCommand(command));
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

  const handleCancel = () => {
    onError(new InteractionCancelledError());
  };

  const handleBackToSelection = () => {
    setStatus("selecting");
  };

  const maxFrameRows = Math.max(1, rows - 1);

  return (
    <Box flexDirection="column" maxHeight={maxFrameRows} overflowY="hidden">
      {status === "loading" && <LoadingView />}
      {status === "selecting" && (
        <SelectCommandView
          candidates={candidates}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      )}
      {status === "resolving" && selectedCandidate && (
        <ResolvePlaceholdersView
          candidate={selectedCandidate}
          placeholders={selectedCandidate.placeholders}
          onResolve={handleResolve}
          onBack={handleBackToSelection}
          onCancel={handleCancel}
        />
      )}
      {(status === "confirming" || status === "done") && selectedCandidate && (
        <ConfirmView
          candidate={selectedCandidate}
          resolvedValues={resolvedValues}
          danger={danger}
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
