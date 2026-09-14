import { useInput } from "ink";

export function useKeyboardInput(
  onInput: Parameters<typeof useInput>[0],
  options?: Parameters<typeof useInput>[1],
): void {
  useInput((input, key) => {
    // 同一按键的释放可能到达下一个视图，必须在确认、取消、导航和删除之前丢弃。
    if (key.eventType !== "release") onInput(input, key);
  }, options);
}
