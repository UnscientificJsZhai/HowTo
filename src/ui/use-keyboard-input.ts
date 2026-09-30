import { useEffect, useState } from "react";
import { useInput, useStdin } from "ink";
import { splitKeyboardInput } from "./text-input.js";

export function useKeyboardInput(
  onInput: Parameters<typeof useInput>[0],
  options?: Parameters<typeof useInput>[1],
): boolean {
  const { isRawModeSupported } = useStdin();
  // renderToString 没有真实输入订阅，应保留同步静态渲染。
  const [ready, setReady] = useState(!isRawModeSupported);
  useInput((input, key) => {
    if (!ready) return;
    // 同一按键的释放可能到达下一个视图，必须在确认、取消、导航和删除之前丢弃。
    if (key.eventType === "release") return;
    // 同步交付给本次视图的回调，不能把剩余按键排队到下一页。
    for (const event of splitKeyboardInput(input, key)) onInput(event.input, event.key);
  }, options);
  // Ink 在被动 effect 中注册输入。先完成订阅，再允许调用方显示可交互帧；
  // 否则立即写出的新页面可能先于它自己的按键监听器接受用户输入。
  useEffect(() => setReady(true), []);
  return ready;
}
