import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { LoadingView } from './LoadingView.js';
import { SelectCommandView } from './SelectCommandView.js';
import { ResolvePlaceholdersView } from './ResolvePlaceholdersView.js';
import { ConfirmView } from './ConfirmView.js';
import type {
  CommandCandidateContract,
  CommandProvider,
  GenerateCommandsRequest,
} from '../ai/types.js';
import { parseAndValidateAiResponse } from '../validation/ai-response.js';
import { validateUseCommandCandidates } from '../validation/command-tool.js';
import { detectDangerousCommand, type DangerousCommandMatch } from '../safety/dangerous-command.js';
import { replaceCommandPlaceholders } from './placeholder-logic.js';
import { InteractionCancelledError } from './tty.js';

type Status = 'loading' | 'selecting' | 'resolving' | 'confirming' | 'error' | 'done';

interface Props {
  provider: CommandProvider;
  request: GenerateCommandsRequest;
  useCommand?: string;
  onSuccess: (command: string) => void;
  onError: (error: Error) => void;
}

export const App: React.FC<Props> = ({ provider, request, useCommand, onSuccess, onError }) => {
  const [status, setStatus] = useState<Status>('loading');
  const [candidates, setCandidates] = useState<CommandCandidateContract[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CommandCandidateContract | null>(null);
  const [finalCommand, setFinalCommand] = useState('');
  const [danger, setDanger] = useState<DangerousCommandMatch | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (status === 'loading') {
      provider
        .generateCommands(request)
        .then((result) => {
          const aiResponse = parseAndValidateAiResponse(result.rawText);
          validateUseCommandCandidates(aiResponse, useCommand);
          setCandidates(aiResponse.commands);
          setStatus('selecting');
        })
        .catch((error) => {
          setErrorMessage(error.message);
          setStatus('error');
          onError(error);
        });
    }
  }, [status, provider, request, useCommand, onError]);

  const handleSelect = (candidate: CommandCandidateContract) => {
    setSelectedCandidate(candidate);
    if (candidate.placeholders.length > 0) {
      setStatus('resolving');
    } else {
      const command = candidate.command;
      setFinalCommand(command);
      setDanger(detectDangerousCommand(command));
      setStatus('confirming');
    }
  };

  const handleResolve = (values: Map<string, string>) => {
    if (!selectedCandidate) return;
    const command = replaceCommandPlaceholders(selectedCandidate.command, values);
    setFinalCommand(command);
    setDanger(detectDangerousCommand(command));
    setStatus('confirming');
  };

  const handleConfirm = () => {
    setStatus('done');
    onSuccess(finalCommand);
  };

  const handleCancel = () => {
    onError(new InteractionCancelledError());
  };

  const handleBackToSelection = () => {
    setStatus('selecting');
  };

  return (
    <Box flexDirection="column">
      {status === 'loading' && <LoadingView />}
      {status === 'selecting' && (
        <SelectCommandView
          candidates={candidates}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      )}
      {status === 'resolving' && selectedCandidate && (
        <ResolvePlaceholdersView
          placeholders={selectedCandidate.placeholders}
          onResolve={handleResolve}
          onBack={handleBackToSelection}
          onCancel={handleCancel}
        />
      )}
      {status === 'confirming' && (
        <ConfirmView
          command={finalCommand}
          danger={danger}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}
      {status === 'error' && (
        <Text color="red">Error: {errorMessage}</Text>
      )}
    </Box>
  );
};
