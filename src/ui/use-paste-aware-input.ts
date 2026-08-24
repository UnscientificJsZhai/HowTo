import { useEffect, useRef } from "react";
import { useInput, usePaste, type Key } from "ink";

interface InputEvent {
  type: "input";
  input: string;
  key: Key;
}

interface PasteEvent {
  type: "paste";
  input: string;
}

type PendingEvent = InputEvent | PasteEvent;

interface Options {
  onInput: (input: string, key: Key) => void;
  onPaste: (input: string) => void;
  isInputActive?: boolean;
  isPasteActive?: boolean;
}

const ORPHANED_BRACKETED_PASTE_END = "[201~";

export function usePasteAwareInput({
  onInput,
  onPaste,
  isInputActive = true,
  isPasteActive = true,
}: Options): void {
  const handlersRef = useRef({ onInput, onPaste });
  const pendingEventsRef = useRef<PendingEvent[] | null>(null);
  handlersRef.current = { onInput, onPaste };

  useEffect(
    () => () => {
      pendingEventsRef.current = null;
    },
    [],
  );

  useInput(
    (input, key) => {
      const pendingEvents = pendingEventsRef.current;
      if (pendingEvents === null) {
        handlersRef.current.onInput(input, key);
        return;
      }

      if (input === ORPHANED_BRACKETED_PASTE_END) {
        pendingEventsRef.current = null;
        return;
      }

      pendingEvents.push({ type: "input", input, key });
    },
    { isActive: isInputActive },
  );

  usePaste(
    (input) => {
      let pendingEvents = pendingEventsRef.current;
      if (pendingEvents === null) {
        const newPendingEvents: PendingEvent[] = [];
        pendingEvents = newPendingEvents;
        pendingEventsRef.current = newPendingEvents;

        queueMicrotask(() => {
          if (pendingEventsRef.current !== newPendingEvents) {
            return;
          }

          pendingEventsRef.current = null;
          for (const event of newPendingEvents) {
            if (event.type === "paste") {
              handlersRef.current.onPaste(event.input);
            } else {
              handlersRef.current.onInput(event.input, event.key);
            }
          }
        });
      }

      pendingEvents.push({ type: "paste", input });
    },
    { isActive: isPasteActive },
  );
}
