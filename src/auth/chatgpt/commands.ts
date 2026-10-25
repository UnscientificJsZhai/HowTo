import type { GlobalOptions } from "../../cli.js";
import { readUserConfigFile } from "../../config-file.js";
import { listChatGptModels } from "../../ai/chatgpt-models.js";
import type { ChatGptInitializationService } from "../../init/index.js";
import { renderTerminalSafeText } from "../../terminal-text.js";
import { InteractionCancelledError } from "../../ui/tty.js";
import { listChatGptAccounts, loginChatGpt, logoutChatGpt } from "./index.js";
import { formatChatGptAuthorizationInstructions } from "./instructions.js";

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

export const chatGptInitializationService: ChatGptInitializationService = {
  listAccounts: (options) => listChatGptAccounts(options),
  login: (options) => loginChatGpt(options),
  listModels: (options) => listChatGptModels(options),
};

export async function runChatGptAction(options: GlobalOptions): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    let accountId = options.chatgptAccount ?? process.env.HOWTO_CHATGPT_ACCOUNT;
    // 独立认证不依赖普通 provider 配置；损坏的 API key 配置不能阻止注销。
    if (accountId === undefined && options.chatgptAction !== "login") {
      if (options.chatgptAction === "status") {
        try {
          accountId = (await readUserConfigFile()).chatgptAccount;
        } catch {
          /* 仍可查看独立的账号存储。 */
        }
      } else {
        accountId = (await readUserConfigFile()).chatgptAccount;
      }
    }
    const signal = controller.signal;
    switch (options.chatgptAction) {
      case "login": {
        console.error("Continue with ChatGPT in your browser. Press Ctrl+C to cancel.");
        const account = await loginChatGpt({
          // 无显式账号的 login 新增注册；选择已存账号时才重用它的 client ID。
          accountId: options.chatgptAccount,
          signal,
          noBrowser: options.noBrowser,
          callbackPort: options.callbackPort,
          onAuthorizationUrl: (url) => console.error(formatChatGptAuthorizationInstructions(url)),
        });
        console.log(`ChatGPT account: ${account.id}`);
        console.log(
          account.planUsageEnabled
            ? "Signed in; ChatGPT plan usage is enabled."
            : "Signed in; ChatGPT plan usage has not been enabled.",
        );
        console.log("Run howto --init to select this account and a model.");
        break;
      }
      case "status": {
        const accounts = await listChatGptAccounts({ signal });
        if (accounts.length === 0) console.log("No ChatGPT accounts. Run howto --chatgpt-login.");
        for (const account of accounts) {
          const selected = account.id === accountId ? " (selected)" : "";
          const status = account.signedIn ? "signed in" : "sign-in required";
          console.log(
            `${account.id}${selected}: ${renderTerminalSafeText(account.label)}; ${status}; plan usage ${account.planUsageEnabled ? "enabled" : "disabled"}`,
          );
        }
        console.log(`Manage usage: ${CHATGPT_USAGE_URL}`);
        break;
      }
      case "models": {
        const models = await listChatGptModels({ accountId, signal });
        for (const model of models)
          console.log(
            `${renderTerminalSafeText(model.slug)}\t${renderTerminalSafeText(model.displayName)}`,
          );
        break;
      }
      case "logout": {
        const result = await logoutChatGpt({ accountId, signal });
        console.log(`Signed out of ChatGPT account ${result.account.id}.`);
        if (!result.remoteRevocationConfirmed) {
          console.error(
            `Remote session revocation was not confirmed. Disconnect HowTo in ChatGPT Settings: ${CHATGPT_USAGE_URL}`,
          );
        }
        break;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) throw new InteractionCancelledError();
    throw error;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
