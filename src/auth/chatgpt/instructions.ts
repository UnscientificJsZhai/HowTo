import { renderTerminalSafeText } from "../../terminal-text.js";

export function formatChatGptAuthorizationInstructions(url: string): string {
  const instructions: string[] = [];
  try {
    const callback = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    if (
      callback.protocol === "http:" &&
      callback.hostname === "127.0.0.1" &&
      callback.pathname === "/auth/callback" &&
      !callback.username &&
      !callback.password &&
      !callback.search &&
      !callback.hash
    ) {
      const port = callback.port || "80";
      instructions.push(
        "If HowTo is running on an SSH server, first run this in another terminal on the computer with your browser:",
        `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:${port}:127.0.0.1:${port} user@server`,
        "Replace user@server with your SSH destination. Keep the tunnel and HowTo running until sign-in completes.",
        "The callback uses 127.0.0.1 on the browser's computer; opening the URL alone will not reach the server.",
      );
    }
  } catch {
    // 非标准链接仍可展示，但不从中拼接 SSH 指令。
  }
  instructions.push("Open this authorization URL in your browser:", renderTerminalSafeText(url));
  return instructions.join("\n");
}
