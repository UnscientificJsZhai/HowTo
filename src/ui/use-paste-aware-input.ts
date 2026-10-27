import { usePaste, type Key } from "ink";
import { useKeyboardInput } from "./use-keyboard-input.js";
import { useOptionalInteractiveSession } from "./InteractiveSessionProvider.js";

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
  const session = useOptionalInteractiveSession();
  // 粘贴只交给接收时的逻辑页面或字段，不因 React 切页重新绑定接收者。
  const ready = useKeyboardInput(onInput, { isActive: isInputActive });
  usePaste(
    (input) => {
      if (!ready || (session && !session.isInputCurrent())) {
        session?.reportStalePaste();
        return;
      }
      onPaste(input);
    },
    { isActive: isPasteActive },
  );
  return ready;
}
