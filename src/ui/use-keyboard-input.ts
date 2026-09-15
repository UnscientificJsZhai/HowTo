import { useInput } from "ink";
import { splitKeyboardInput } from "./text-input.js";

export function useKeyboardInput(
  onInput: Parameters<typeof useInput>[0],
  options?: Parameters<typeof useInput>[1],
): void {
  useInput((input, key) => {
    // 同一按键的释放可能到达下一个视图，必须在确认、取消、导航和删除之前丢弃。
    if (key.eventType === "release") return;
    // 同步交付给本次视图的回调，不能把剩余按键排队到下一页。
    for (const event of splitKeyboardInput(input, key)) onInput(event.input, event.key);
  }, options);
}
