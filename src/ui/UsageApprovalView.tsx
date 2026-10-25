import React, { useRef, useState, useLayoutEffect } from "react";
import { Box, Text, type Key } from "ink";
import stringWidth from "string-width";
import type { UsageApprovalRequest } from "../usage/types.js";
import {
  formatLiteralArguments,
  formatUsageCommand,
  parseLiteralArguments,
  validateUsageLookupArguments,
} from "../usage/arguments.js";
import { resolveUsageCommandDanger } from "../usage/risk.js";
import { renderTerminalSafeText } from "../terminal-text.js";
import { useInteractiveSession } from "./InteractiveSessionProvider.js";
import { usePasteAwareInput } from "./use-paste-aware-input.js";
import { deleteLastGrapheme, isTextInputEvent } from "./text-input.js";
import { toTailPreview } from "./single-line-preview.js";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Props {
  request: UsageApprovalRequest;
  availableRows: number;
  availableColumns: number;
  knownCredentials?: readonly string[];
  onApprove: (args: string[]) => void;
  onReject: () => void;
  onCancel: () => void;
}

export const UsageApprovalView: React.FC<Props> = (props) => {
  const session = useInteractiveSession();
  const [args, setArgs] = useState(props.request.lookup.args);
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState(0);
  // 每个页面取得新的输入边界，上一页同批输入不能批准下一页。
  useLayoutEffect(() => session.beginView(), [session, editing, revision]);
  const danger =
    revision === 0
      ? props.request.danger
      : resolveUsageCommandDanger(
          props.request.commandName,
          props.request.executable,
          args,
          props.request.lookup,
        );

  const switchPage = (nextEditing: boolean) => {
    session.suspendViewInput();
    setEditing(nextEditing);
  };
  return editing ? (
    <UsageArgumentsEditor
      {...props}
      args={args}
      onSave={(nextArgs) => {
        session.suspendViewInput();
        setArgs(nextArgs);
        setRevision((previous) => previous + 1);
        setEditing(false);
      }}
      onBack={() => switchPage(false)}
    />
  ) : (
    <UsageReview
      {...props}
      key={revision}
      request={{ ...props.request, danger }}
      args={args}
      onEdit={() => switchPage(true)}
    />
  );
};

function UsageReview({
  request,
  args,
  availableRows,
  availableColumns,
  knownCredentials = [],
  onApprove,
  onReject,
  onCancel,
  onEdit,
}: Props & { args: string[]; onEdit: () => void }) {
  const session = useInteractiveSession();
  const [scroll, setScroll] = useState(0);
  const [confirmation, setConfirmation] = useState("");
  const confirmationRef = useRef("");
  const finished = useRef(false);
  const columns = Math.max(1, availableColumns);
  const bodyRows = Math.max(1, availableRows - (availableRows >= 2 ? 1 : 0));
  const safe = (value: string) => safeUsageDisplay(value, knownCredentials ?? []);
  const controls = request.danger
    ? "输入 EXECUTE 后 Enter 批准；Tab 编辑；Esc 拒绝；↑↓ 查看；Ctrl+C 取消"
    : "Enter 批准；Tab 编辑；Esc 拒绝；↑↓ 查看；Ctrl+C 取消";
  const lines = [
    "查询审批（↑↓ 查看全部内容）",
    `程序: ${safe(request.commandName)}`,
    `实际路径: ${safe(request.executable)}`,
    `命令: ${safe(formatUsageCommand(request.executable, args))}`,
    `目的: ${safe(request.lookup.purpose)}`,
    `风险: ${request.danger ? safe(request.danger.reason) : "未发现已知风险"}`,
    "批准同时授权将本次查询输出发送给当前 AI provider。",
    controls,
    ...(request.danger ? [`EXECUTE> ${confirmation}`] : []),
  ].flatMap((line) => wrapUsageText(line, columns));
  const maximumScroll = Math.max(0, lines.length - bodyRows);
  const offset = Math.min(scroll, maximumScroll);
  const inputReady = usePasteAwareInput({
    onInput: (input: string, key: Key) => {
      if (finished.current || availableRows <= 0) return;
      if (key.ctrl && input === "c") {
        finished.current = true;
        onCancel();
      } else if (key.escape) {
        finished.current = true;
        onReject();
      } else if (key.tab) {
        finished.current = true;
        onEdit();
      } else if (key.upArrow || key.pageUp) {
        setScroll((previous) => Math.max(0, previous - (key.pageUp ? bodyRows : 1)));
      } else if (key.downArrow || key.pageDown) {
        setScroll((previous) => Math.min(maximumScroll, previous + (key.pageDown ? bodyRows : 1)));
      } else if (key.return) {
        if (!request.danger || confirmationRef.current.toUpperCase() === "EXECUTE") {
          finished.current = true;
          onApprove(args);
        }
      } else if (request.danger) {
        if (key.backspace || key.delete) {
          confirmationRef.current = deleteLastGrapheme(confirmationRef.current);
        } else if (isTextInputEvent(input, key)) {
          confirmationRef.current += input;
        }
        setConfirmation(confirmationRef.current);
        if (availableRows === 1) setScroll(Number.MAX_SAFE_INTEGER);
      }
    },
    onPaste: session.reportIgnoredPaste,
    isPasteActive: availableRows > 0,
  });

  if (!inputReady || availableRows <= 0) return null;
  return (
    <Box
      flexDirection="column"
      height={Math.min(availableRows, lines.length + 1)}
      overflowY="hidden"
    >
      {lines.slice(offset, offset + bodyRows).map((line, index) => (
        <Text key={index} color={request.danger ? "yellow" : undefined}>
          {line}
        </Text>
      ))}
      {availableRows >= 2 && (
        <Text wrap="truncate-end">
          {request.danger
            ? `EXECUTE> ${toTailPreview(confirmation, Math.max(0, columns - 20))} Enter Tab Esc ↑↓`
            : "Enter批准 Tab编辑 Esc拒绝 ↑↓"}
        </Text>
      )}
    </Box>
  );
}

function UsageArgumentsEditor({
  request,
  args,
  availableRows,
  availableColumns,
  knownCredentials = [],
  onSave,
  onBack,
  onCancel,
}: Props & { args: string[]; onSave: (args: string[]) => void; onBack: () => void }) {
  const session = useInteractiveSession();
  const initial = formatLiteralArguments(args);
  const [value, setValue] = useState(initial);
  const [cursor, setCursor] = useState(initial.length);
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const detailsRef = useRef(false);
  const [detailScroll, setDetailScroll] = useState(0);
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  const finished = useRef(false);
  useLayoutEffect(() => session.beginView(), [session, details]);
  const columns = Math.max(1, availableColumns);
  const safeProgram = safeUsageDisplay(request.executable, knownCredentials ?? []);
  const detailRows = Math.max(1, availableRows - (availableRows >= 2 ? 1 : 0));
  const detailLines = [
    ...(error ? [error] : []),
    `固定程序: ${safeUsageDisplay(request.commandName, knownCredentials ?? [])}`,
    `实际路径: ${safeProgram}`,
    "仅编辑参数；支持引号、←→、Home/End、字素级删除。",
    "Enter 保存并重新审批；Esc 返回；Tab 查看详情；Ctrl+C 取消。",
  ].flatMap((line) => wrapUsageText(line, columns));
  const maximumDetailScroll = Math.max(0, detailLines.length - detailRows);
  const showDetails = (visible: boolean) => {
    if (visible !== detailsRef.current) session.suspendViewInput();
    detailsRef.current = visible;
    setDetails(visible);
    setDetailScroll(0);
  };
  const update = (nextValue: string, nextCursor: number) => {
    // 插入的基字符可能与右侧已有组合符重新形成字素；光标不能停在新字素内部。
    const containing = graphemes.segment(nextValue).containing(nextCursor);
    if (containing !== undefined && containing.index < nextCursor) {
      nextCursor = containing.index + containing.segment.length;
    }
    valueRef.current = nextValue;
    cursorRef.current = nextCursor;
    setValue(nextValue);
    setCursor(nextCursor);
    setError("");
    showDetails(false);
  };
  const inputReady = usePasteAwareInput({
    onInput: (input: string, key: Key) => {
      if (finished.current || availableRows <= 0) return;
      const current = valueRef.current;
      const position = cursorRef.current;
      if (key.ctrl && input === "c") {
        finished.current = true;
        onCancel();
      } else if (key.tab) {
        showDetails(!detailsRef.current);
      } else if (detailsRef.current && (key.upArrow || key.pageUp)) {
        setDetailScroll((previous) => Math.max(0, previous - (key.pageUp ? detailRows : 1)));
      } else if (detailsRef.current && (key.downArrow || key.pageDown)) {
        setDetailScroll((previous) =>
          Math.min(maximumDetailScroll, previous + (key.pageDown ? detailRows : 1)),
        );
      } else if (detailsRef.current && (key.return || key.escape)) {
        showDetails(false);
      } else if (key.escape) {
        finished.current = true;
        onBack();
      } else if (key.return) {
        try {
          const parsed = validateUsageLookupArguments({
            ...request.lookup,
            args: parseLiteralArguments(current),
          });
          finished.current = true;
          onSave(parsed.args);
        } catch {
          setError("参数无效：仅允许字面参数；请检查引号、shell 操作符和展开语法。");
          if (availableRows <= 2) showDetails(true);
        }
      } else if (key.home || (key.ctrl && input === "a")) {
        update(current, 0);
      } else if (key.end || (key.ctrl && input === "e")) {
        update(current, current.length);
      } else if (key.ctrl && input === "u") {
        update(current.slice(position), 0);
      } else if (key.leftArrow) {
        update(current, previousGraphemeOffset(current, position));
      } else if (key.rightArrow) {
        update(current, nextGraphemeOffset(current, position));
      } else if (key.backspace) {
        const previous = previousGraphemeOffset(current, position);
        update(current.slice(0, previous) + current.slice(position), previous);
      } else if (key.delete) {
        update(
          current.slice(0, position) + current.slice(nextGraphemeOffset(current, position)),
          position,
        );
      } else if (isTextInputEvent(input, key)) {
        update(
          current.slice(0, position) + input + current.slice(position),
          position + input.length,
        );
      }
    },
    onPaste: (input) => {
      if (finished.current || availableRows <= 0) return;
      const position = cursorRef.current;
      const current = valueRef.current;
      update(current.slice(0, position) + input + current.slice(position), position + input.length);
    },
    isPasteActive: availableRows > 0,
  });

  if (!inputReady || availableRows <= 0) return null;
  if (details) {
    const offset = Math.min(detailScroll, maximumDetailScroll);
    return (
      <Box flexDirection="column" maxHeight={availableRows} overflowY="hidden">
        {detailLines.slice(offset, offset + detailRows).map((line, index) => (
          <Text key={index} color={error ? "red" : undefined}>
            {line}
          </Text>
        ))}
        {availableRows >= 2 && <Text wrap="truncate-end">↑↓查看 Tab返回编辑</Text>}
      </Box>
    );
  }
  // 等长遮罩保留光标位置；在切片前完成脱敏，避免光标切开凭据后暴露部分内容。
  const safeValue = knownCredentials
    .filter((credential) => credential !== "")
    .reduce(
      (text, credential) => text.split(credential).join("*".repeat(credential.length)),
      value,
    );
  const programPreview = clippedProgram(safeProgram, Math.max(1, Math.floor(columns / 3)));
  const prefix = availableRows === 1 ? `${error ? "!" : ""}${programPreview}:` : "> ";
  const inputColumns = Math.max(1, columns - stringWidth(prefix));
  const before = toTailPreview(safeValue.slice(0, cursor), Math.max(0, inputColumns - 1));
  const after =
    wrapUsageText(
      renderTerminalSafeText(safeValue.slice(cursor)),
      Math.max(1, inputColumns - stringWidth(before)),
    )[0] ?? " ";
  const cursorText = graphemes.segment(after)[Symbol.iterator]().next().value?.segment ?? " ";
  const suffix = after.slice(cursorText.length);
  return (
    <Box flexDirection="column" maxHeight={availableRows} overflowY="hidden" overflowX="hidden">
      {availableRows >= 3 && (
        <Text wrap="truncate-end">编辑查询参数（程序固定）: {safeProgram}</Text>
      )}
      {availableRows === 2 && (
        <Text wrap="truncate-end">
          {error ? "! " : ""}
          {clippedProgram(safeProgram, Math.max(1, columns - 8))} Tab详情
        </Text>
      )}
      <Box height={1} overflowX="hidden">
        <Text>
          {prefix}
          {before}
          <Text inverse>{cursorText}</Text>
          {suffix}
        </Text>
      </Box>
      {availableRows >= 3 && (
        <Text color={error ? "red" : undefined} wrap="truncate-end">
          {error || "Enter保存并重新审批 Esc返回 ←→移动 Tab详情 Ctrl+C取消"}
        </Text>
      )}
    </Box>
  );
}

export function previousGraphemeOffset(value: string, offset: number): number {
  return graphemes.segment(value).containing(offset - 1)?.index ?? 0;
}

export function nextGraphemeOffset(value: string, offset: number): number {
  const next = graphemes.segment(value).containing(offset);
  return next === undefined ? value.length : next.index + next.segment.length;
}

export function wrapUsageText(value: string, columns: number): string[] {
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const { segment } of graphemes.segment(value)) {
    const size = stringWidth(segment);
    if (line !== "" && width + size > Math.max(1, columns)) {
      lines.push(line);
      line = "";
      width = 0;
    }
    line += segment;
    width += size;
  }
  lines.push(line);
  return lines;
}

function clippedProgram(value: string, columns: number): string {
  return stringWidth(value) <= columns
    ? value
    : `…${toTailPreview(value, Math.max(0, columns - 1))}`;
}

function safeUsageDisplay(value: string, credentials: readonly string[]): string {
  const redacted = credentials
    .filter((credential) => credential !== "")
    .sort((left, right) => right.length - left.length)
    .reduce((text, credential) => text.split(credential).join("[REDACTED]"), value);
  return renderTerminalSafeText(redacted);
}
