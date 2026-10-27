import React, { createContext, useContext, useEffect, useLayoutEffect } from "react";
import { useStderr } from "ink";
import type { InteractiveSession } from "./interactive-session.js";

const SessionContext = createContext<InteractiveSession | undefined>(undefined);
export const InteractiveSessionProvider: React.FC<
  React.PropsWithChildren<{ session: InteractiveSession }>
> = ({ session, children }) => {
  const { write } = useStderr();
  useLayoutEffect(() => session.beginView(), [session]);
  useEffect(
    () => session.subscribeInputNotice((message) => write(`提示：${message}\n`)),
    [session, write],
  );
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
};

export function useInteractiveSession(): InteractiveSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("交互视图必须使用受管理的终端会话。");
  return session;
}

export function useOptionalInteractiveSession(): InteractiveSession | undefined {
  return useContext(SessionContext);
}
