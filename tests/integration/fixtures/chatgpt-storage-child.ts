import { setTimeout as delay } from "node:timers/promises";

import { createChatGptStore } from "../../../src/auth/chatgpt/storage.js";

async function main(): Promise<void> {
  const [home, mode] = process.argv.slice(2);
  const controller = new AbortController();
  const timer = mode === "cancel" ? setTimeout(() => controller.abort(), 150) : undefined;
  try {
    await createChatGptStore(home).withLock(async (transaction) => {
      process.send?.({ event: "entered" });
      if (mode === "hold") {
        await new Promise<void>((resolve) => process.once("message", () => resolve()));
      } else {
        const state = await transaction.read();
        if (state.accounts.length === 0) {
          state.accounts.push({
            id: "fixture-account",
            label: "fixture-account",
            clientId: "fixture-client",
            issuer: "https://auth.openai.com",
            generation: 0,
          });
        }
        // 扩大读写窗口，验证另一个进程必须在第一次提交之后才能读取。
        await delay(40);
        state.accounts[0].generation += 1;
        await transaction.save(state);
      }
      process.send?.({ event: "done", hostId: await transaction.getHostId() });
    }, controller.signal);
  } catch (error) {
    if (mode === "cancel" && error instanceof Error && error.name === "AbortError") {
      process.send?.({ event: "cancelled" });
    } else {
      process.send?.({ event: "failed" });
      process.exitCode = 1;
    }
  } finally {
    clearTimeout(timer);
    process.disconnect?.();
  }
}

void main();
