import React from "react";
import { render } from "ink";
import type { CommandProvider, GenerateCommandsRequest } from "../ai/types.js";
import { executeCommand } from "../execute.js";
import { App } from "./App.js";
import type { InteractiveSession } from "./interactive-session.js";
import { InteractiveSessionProvider } from "./InteractiveSessionProvider.js";

export const MANUAL_EXECUTION_NOTICE =
  "本次会话包含粘贴，howto 不会自动执行命令。请检查输出内容后手动运行。";

export async function runInteractiveCommand({
  session,
  provider,
  request,
  execute = executeCommand,
  print = (command) => {
    console.error(MANUAL_EXECUTION_NOTICE);
    console.log(command);
  },
}: {
  session: InteractiveSession;
  provider: CommandProvider;
  request: GenerateCommandsRequest;
  execute?: (command: string) => Promise<number>;
  print?: (command: string) => void;
}): Promise<number> {
  let finalCommand: string | undefined;
  let appError: Error | undefined;
  const instance = render(
    <InteractiveSessionProvider session={session}>
      <App
        provider={provider}
        request={request}
        onSuccess={(command) => {
          finalCommand = command;
          session.suspendViewInput();
          instance.clear();
          instance.unmount();
        }}
        onError={(error) => {
          appError = error;
          session.suspendViewInput();
          instance.clear();
          instance.unmount();
        }}
      />
    </InteractiveSessionProvider>,
    { stdin: session.input, stdout: session.output, exitOnCtrlC: false },
  );
  const unsubscribe = session.subscribeFailure((error) => {
    appError = error;
    instance.clear();
    instance.unmount();
  });
  try {
    await instance.waitUntilExit();
    if (appError) throw appError;
    if (finalCommand === undefined) return 1;
    const command = finalCommand;
    return await session.handoff({
      execute: () => execute(command),
      print: () => {
        print(command);
        return Promise.resolve(0);
      },
    });
  } finally {
    unsubscribe();
    instance.unmount();
  }
}
