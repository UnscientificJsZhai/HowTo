import React, { useEffect, useRef, useState, useLayoutEffect } from "react";
import { Box, Text, useStdout } from "ink";
import { getUserVisibleErrorMessage } from "../errors.js";
import { formatChatGptAuthorizationInstructions } from "../auth/chatgpt/instructions.js";
import type { ChatGptLoginOptions } from "../auth/chatgpt/types.js";
import { toSingleLinePreview } from "../ui/single-line-preview.js";
import { isTextInputEvent } from "../ui/text-input.js";
import { usePasteAwareInput } from "../ui/use-paste-aware-input.js";
import { useInteractiveSession } from "../ui/InteractiveSessionProvider.js";
import type {
  ChatGptInitializationAccount,
  ChatGptInitializationModel,
  ChatGptInitializationService,
  InitializationValues,
} from "./index.js";

interface Props {
  service?: ChatGptInitializationService;
  loginOptions?: ChatGptLoginOptions;
  frameRows: number;
  onComplete: (values: Extract<InitializationValues, { provider: "chatgpt" }>) => void;
  onBack: () => void;
  onCancel: () => void;
}

type SetupState =
  | { step: "loading"; message: string }
  | { step: "accounts"; accounts: ChatGptInitializationAccount[]; selectedIndex: number }
  | {
      step: "models";
      account: ChatGptInitializationAccount;
      models: ChatGptInitializationModel[];
      selectedIndex: number;
    }
  | { step: "error"; message: string };

export const ChatGptInitializationStep: React.FC<Props> = ({
  service,
  loginOptions,
  frameRows,
  onComplete,
  onBack,
  onCancel,
}) => {
  const session = useInteractiveSession();
  const { write: writeStdout } = useStdout();
  const writeStdoutRef = useRef(writeStdout);
  writeStdoutRef.current = writeStdout;
  const [state, setState] = useState<SetupState>({
    step: "loading",
    message: "Loading ChatGPT accounts...",
  });
  const stateRef = useRef(state);
  const operationRef = useRef<AbortController | undefined>(undefined);
  const finishedRef = useRef(false);
  useLayoutEffect(() => session.beginView(), [session, state.step]);

  const updateState = (next: SetupState) => {
    if (next.step !== stateRef.current.step) session.suspendViewInput();
    stateRef.current = next;
    setState(next);
  };

  const startOperation = (run: (signal: AbortSignal) => Promise<void>) => {
    operationRef.current?.abort();
    const controller = new AbortController();
    operationRef.current = controller;
    void run(controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted || finishedRef.current) return;
      updateState({
        step: "error",
        message:
          error instanceof Error
            ? getUserVisibleErrorMessage(error)
            : "ChatGPT setup failed. Please retry.",
      });
    });
  };

  const loadAccounts = () => {
    updateState({ step: "loading", message: "Loading ChatGPT accounts..." });
    startOperation(async (signal) => {
      if (service === undefined) throw new Error("ChatGPT sign-in is unavailable.");
      const accounts = await service.listAccounts({ signal });
      if (signal.aborted || finishedRef.current) return;
      updateState({ step: "accounts", accounts, selectedIndex: 0 });
    });
  };

  useEffect(() => {
    finishedRef.current = false;
    loadAccounts();
    return () => {
      finishedRef.current = true;
      operationRef.current?.abort();
    };
    // 一次挂载对应一次初始化，返回 provider 页后重新挂载才重新读取账号。
  }, []);

  const loadModels = async (account: ChatGptInitializationAccount, signal: AbortSignal) => {
    if (service === undefined) throw new Error("ChatGPT sign-in is unavailable.");
    if (!account.signedIn || !account.planUsageEnabled) {
      throw new Error("ChatGPT plan usage is not enabled. Sign in again and allow plan usage.");
    }
    updateState({ step: "loading", message: "Loading ChatGPT models..." });
    const models = await service.listModels({ accountId: account.id, signal });
    if (signal.aborted || finishedRef.current) return;
    if (models.length === 0) throw new Error("No ChatGPT models are available for this account.");
    updateState({ step: "models", account, models, selectedIndex: 0 });
  };

  const selectAccount = (account: ChatGptInitializationAccount | undefined) => {
    startOperation(async (signal) => {
      if (service === undefined) throw new Error("ChatGPT sign-in is unavailable.");
      if (account?.signedIn && account.planUsageEnabled) {
        await loadModels(account, signal);
        return;
      }
      updateState({
        step: "loading",
        message: "Complete ChatGPT sign-in in your browser...",
      });
      const publishedUrls = new Set<string>();
      const signedInAccount = await service.login({
        ...loginOptions,
        accountId: account?.id,
        signal,
        onAuthorizationUrl: (url) => {
          if (signal.aborted || finishedRef.current) return;
          // 再授权 URL 可能携带 ID token；即便适配层误传也不渲染这类地址。
          let authorizationUrl: string;
          try {
            const parsed = new URL(url);
            if (parsed.searchParams.has("id_token_hint")) return;
            parsed.searchParams.delete("login_hint");
            authorizationUrl = parsed.toString();
          } catch {
            return;
          }
          // 通过 Ink 的外部输出入口写完整链接，保留在滚动历史中，不受帧高度或缩放裁剪。
          if (!publishedUrls.has(authorizationUrl)) {
            publishedUrls.add(authorizationUrl);
            writeStdoutRef.current(`${formatChatGptAuthorizationInstructions(authorizationUrl)}\n`);
          }
          updateState({
            step: "loading",
            message: "Open the sign-in URL above in your browser...",
          });
        },
      });
      if (signal.aborted || finishedRef.current) return;
      await loadModels(signedInAccount, signal);
    });
  };

  const finish = (callback: () => void) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    session.suspendViewInput();
    operationRef.current?.abort();
    callback();
  };

  const ready = usePasteAwareInput({
    onInput: (input, key) => {
      if (finishedRef.current || key.eventType === "release") return;
      if (key.ctrl && input === "c") {
        finish(onCancel);
        return;
      }
      if (frameRows === 0) return;
      if (key.escape) {
        finish(onBack);
        return;
      }
      const current = stateRef.current;
      if (current.step === "loading") return;
      if (current.step === "error") {
        if (key.return) loadAccounts();
        return;
      }
      const count =
        current.step === "accounts" ? current.accounts.length + 1 : current.models.length;
      if (key.upArrow || key.downArrow) {
        updateState({
          ...current,
          selectedIndex: (current.selectedIndex + (key.upArrow ? -1 : 1) + count) % count,
        });
        return;
      }
      let selectedIndex = current.selectedIndex;
      if (isTextInputEvent(input, key) && /^[1-9]$/.test(input)) {
        selectedIndex = Number(input) - 1;
        if (selectedIndex >= count) return;
      } else if (!key.return) {
        return;
      }
      if (current.step === "accounts") {
        selectAccount(current.accounts[selectedIndex]);
      } else {
        finish(() =>
          onComplete({
            provider: "chatgpt",
            account: current.account.id,
            model: current.models[selectedIndex].slug,
          }),
        );
      }
    },
    onPaste: session.reportIgnoredPaste,
    isPasteActive: true,
  });

  if (!ready || frameRows === 0) return null;

  const choices =
    state.step === "accounts"
      ? [
          ...state.accounts.map(
            (account) =>
              `${account.label}${account.signedIn && account.planUsageEnabled ? "" : " (sign in)"}`,
          ),
          "Continue with ChatGPT",
        ]
      : state.step === "models"
        ? state.models.map((model) => model.displayName || model.slug)
        : [];
  const selectedIndex =
    state.step === "accounts" || state.step === "models" ? state.selectedIndex : 0;
  const selectedLine = choices[selectedIndex];
  const status =
    state.step === "loading" || state.step === "error" ? state.message : `> ${selectedLine}`;

  if (frameRows === 1) {
    return (
      <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
        <Box flexGrow={1} flexShrink={1} minWidth={1} overflowX="hidden">
          <Text>{toSingleLinePreview(status)}</Text>
        </Box>
        <Box flexShrink={0}>
          <Text dimColor> Ent Esc ^C</Text>
        </Box>
      </Box>
    );
  }

  const help = state.step === "loading" ? "Esc back ^C cancel" : "UD Ent Esc back ^C";
  const title =
    state.step === "accounts"
      ? "? ChatGPT account"
      : state.step === "models"
        ? "? ChatGPT model"
        : state.step === "error"
          ? "ChatGPT setup failed"
          : "ChatGPT sign-in";
  const availableChoices = Math.max(1, frameRows - 2);
  const firstChoice = Math.min(selectedIndex, Math.max(0, choices.length - availableChoices));

  return (
    <Box flexDirection="column" maxHeight={frameRows} overflowX="hidden" overflowY="hidden">
      {frameRows >= 3 && (
        <SetupLine color={state.step === "error" ? "red" : "green"}>{title}</SetupLine>
      )}
      {choices.length > 0 ? (
        choices
          .slice(firstChoice, firstChoice + availableChoices)
          .map((choice, index) => (
            <SetupLine key={firstChoice + index}>
              {`${firstChoice + index === selectedIndex ? ">" : " "} ${toSingleLinePreview(choice)}`}
            </SetupLine>
          ))
      ) : (
        <SetupLine>{toSingleLinePreview(status)}</SetupLine>
      )}
      <SetupLine>{state.step === "error" ? "Ent retry Esc back ^C" : help}</SetupLine>
    </Box>
  );
};

const SetupLine: React.FC<{ children: React.ReactNode; color?: "green" | "red" }> = ({
  children,
  color,
}) => (
  <Box height={1} maxHeight={1} overflowX="hidden" overflowY="hidden">
    <Text color={color}>{children}</Text>
  </Box>
);
