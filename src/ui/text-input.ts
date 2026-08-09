import type { Key } from "ink";

export function isTextInputEvent(input: string, key: Key): boolean {
  return (
    input.length > 0 &&
    key.eventType !== "release" &&
    !key.ctrl &&
    !key.meta &&
    !key.super &&
    !key.hyper &&
    !key.upArrow &&
    !key.downArrow &&
    !key.leftArrow &&
    !key.rightArrow &&
    !key.pageUp &&
    !key.pageDown &&
    !key.home &&
    !key.end &&
    !key.tab &&
    !key.return &&
    !key.escape &&
    !key.backspace &&
    !key.delete
  );
}
