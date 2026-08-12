import React, { useState } from "react";
import { Box, Text, useInput, type Key } from "ink";
import type { CommandCandidateContract } from "../ai/types.js";
import { toSingleLinePreview } from "./single-line-preview.js";

interface Props {
  candidates: CommandCandidateContract[];
  availableRows: number;
  isInputActive?: boolean;
  onSelect: (candidate: CommandCandidateContract) => void;
  onCancel: () => void;
}

interface CandidateProps {
  candidate: CommandCandidateContract;
  isSelected: boolean;
  showTitle: boolean;
  showDescription: boolean;
}

export const SelectCommandView: React.FC<Props> = ({
  candidates,
  availableRows,
  isInputActive = true,
  onSelect,
  onCancel,
}) => {
  const [activeIndex, setActiveIndex] = useState(0);

  useInput((input: string, key: Key) => {
    if (!isInputActive || availableRows <= 0) return;

    if (key.escape || (key.ctrl && input === "c")) {
      onCancel();
      return;
    }

    if (key.upArrow) {
      setActiveIndex((prev) => (prev - 1 + candidates.length) % candidates.length);
    }

    if (key.downArrow) {
      setActiveIndex((prev) => (prev + 1) % candidates.length);
    }

    if (key.return) {
      onSelect(candidates[activeIndex]);
    }
  });

  if (availableRows <= 0) {
    return null;
  }

  const currentCandidate = candidates[activeIndex];
  const page = `${activeIndex + 1}/${candidates.length}`;

  if (availableRows === 1) {
    return (
      <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
        <Box
          height={1}
          maxHeight={1}
          flexGrow={1}
          flexShrink={1}
          minWidth={1}
          overflowX="hidden"
          overflowY="hidden"
        >
          <Text color="gray">{toSingleLinePreview(currentCandidate.command)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor>{` ${page} UD Enter Esc`}</Text>
        </Box>
      </Box>
    );
  }

  if (availableRows === 2) {
    return (
      <Box flexDirection="column" maxHeight={2} overflowX="hidden" overflowY="hidden">
        <Box flexShrink={0} overflowX="hidden">
          <Box flexShrink={0}>
            <Text color="green">{`? ${page} `}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={1} overflowX="hidden">
            <Text color="gray" wrap="truncate-middle">
              {toSingleLinePreview(currentCandidate.command)}
            </Text>
          </Box>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate-end">
            ↑↓; Enter; Esc/^C
          </Text>
        </Box>
      </Box>
    );
  }

  const expandedRows = candidates.length * 4 + 1;
  const isCompact = availableRows < expandedRows;
  const visibleCandidates = isCompact ? [currentCandidate] : candidates;
  const showCompactTitleInHeader = isCompact && availableRows < 4;
  const showTitle = !showCompactTitleInHeader;
  const showDescription = !isCompact || availableRows >= 5;

  return (
    <Box flexDirection="column" maxHeight={availableRows} overflowX="hidden" overflowY="hidden">
      {showCompactTitleInHeader ? (
        <Text wrap="truncate-end">
          <Text color="green">{`? Select (${activeIndex + 1}/${candidates.length}) `}</Text>
          <Text inverse bold>
            {toSingleLinePreview(currentCandidate.title)}
          </Text>
        </Text>
      ) : (
        <Text color="green" wrap="truncate-end">
          ? Select a command{isCompact ? ` (${activeIndex + 1}/${candidates.length})` : ""}
        </Text>
      )}
      <Box flexDirection="column" overflowY="hidden">
        {visibleCandidates.map((candidate, visibleIndex) => {
          const candidateIndex = isCompact ? activeIndex : visibleIndex;
          const isLast = visibleIndex === visibleCandidates.length - 1;
          return (
            <React.Fragment key={candidateIndex}>
              <CommandCandidate
                candidate={candidate}
                isSelected={candidateIndex === activeIndex}
                showTitle={showTitle}
                showDescription={showDescription}
              />
              {!isLast && (
                <Box height={1} flexShrink={0}>
                  <Text> </Text>
                </Box>
              )}
            </React.Fragment>
          );
        })}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {showCompactTitleInHeader
            ? "↑↓; Enter; Esc/^C"
            : "Up/Down move; Enter select; Esc/Ctrl+C cancel."}
        </Text>
      </Box>
    </Box>
  );
};

const CommandCandidate: React.FC<CandidateProps> = ({
  candidate,
  isSelected,
  showTitle,
  showDescription,
}) => (
  <Box flexDirection="column" flexShrink={0}>
    {showTitle && (
      <Box>
        <Text color={isSelected ? "cyan" : undefined}>{isSelected ? "> " : "  "}</Text>
        <Box flexGrow={1} overflowX="hidden">
          <Text inverse={isSelected} bold={isSelected} wrap="truncate-end">
            {toSingleLinePreview(candidate.title)}
          </Text>
        </Box>
      </Box>
    )}
    <Box paddingLeft={4} flexGrow={1} flexShrink={1} minWidth={1} overflowX="hidden">
      <Text color="gray" wrap="truncate-middle">
        {toSingleLinePreview(candidate.command)}
      </Text>
    </Box>
    {showDescription && (
      <Box paddingLeft={4}>
        <Text italic color="dim" wrap="truncate-end">
          {toSingleLinePreview(candidate.description)}
        </Text>
      </Box>
    )}
  </Box>
);
