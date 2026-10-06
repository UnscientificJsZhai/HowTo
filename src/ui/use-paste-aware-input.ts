import { usePaste, type Key } from "ink";
import { useKeyboardInput } from "./use-keyboard-input.js";

interface Options {
  onInput: (input: string, key: Key) => void;
  onPaste: (input: string) => void;
  isInputActive?: boolean;
  isPasteActive?: boolean;
}

export function usePasteAwareInput({
  onInput,
  onPaste,
  isInputActive = true,
  isPasteActive = true,
}: Options): boolean {
  // 原始会话按顺序交付完整粘贴；此 hook 不承担恢复或授予执行权限的职责。
  const ready = useKeyboardInput(onInput, { isActive: isInputActive });
  usePaste(
    (input) => {
      if (ready) onPaste(input);
    },
    { isActive: isPasteActive },
  );
  return ready;
}
