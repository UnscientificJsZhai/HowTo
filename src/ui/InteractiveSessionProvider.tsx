import React, { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { InteractiveSession } from "./interactive-session.js";

const SessionContext = createContext<InteractiveSession | undefined>(undefined);
export const InteractiveSessionProvider: React.FC<
  React.PropsWithChildren<{ session: InteractiveSession }>
> = ({ session, children }) => {
  useEffect(() => session.beginView(), [session]);
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
};

export function useInteractiveSession(): InteractiveSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("交互视图必须使用受管理的终端会话。");
  return session;
}

const subscribeWithoutSession = () => () => {};
const keyboardPolicy = () => "execute" as const;
export function useExecutionPolicy() {
  const session = useContext(SessionContext);
  const policy = useSyncExternalStore(
    session?.subscribeExecutionPolicy ?? subscribeWithoutSession,
    session?.getExecutionPolicy ?? keyboardPolicy,
    keyboardPolicy,
  );
  return { policy, getPolicy: session?.getExecutionPolicy ?? keyboardPolicy };
}
