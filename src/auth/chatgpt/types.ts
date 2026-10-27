export interface ChatGptLoginOptions {
  noBrowser?: boolean;
  callbackPort?: number;
}

export interface HostRecord {
  version: 1;
  hostId: string;
}

export interface ChatGptTokens {
  accessToken: string;
  refreshToken?: string;
  idToken: string;
  scopes: string[];
  expiresAt: number;
  earliestRefreshAt?: number;
  savedAt: number;
}

export interface AccountRecord {
  id: string;
  label: string;
  clientId: string;
  issuer: "https://auth.openai.com";
  subject?: string;
  email?: string;
  generation: number;
  refreshState?: "refreshing" | "reauth_required";
  tokens?: ChatGptTokens;
}

export interface AccountStore {
  version: 1;
  accounts: AccountRecord[];
}
