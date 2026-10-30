const MESSAGES = {
  model_unavailable: [
    2,
    "The selected ChatGPT model is unavailable. Run howto --chatgpt-models or howto --init; the saved selection was not changed.",
  ],
  fast_unsupported: [
    2,
    "ChatGPT Fast was denied for this account/model. Check plan access or set --chatgpt-fast false; no standard-tier retry was sent.",
  ],
  login_required: [2, "ChatGPT sign-in is required. Run howto --chatgpt-login."],
  account_required: [2, "Choose a ChatGPT account with --chatgpt-account or howto --init."],
  account_not_found: [2, "The selected ChatGPT account is not registered on this host."],
  plan_permission: [
    2,
    "ChatGPT plan usage is not enabled. Run howto --chatgpt-login for this account and grant access.",
  ],
  authorization_failed: [
    2,
    "ChatGPT authorization was not completed. Run howto --chatgpt-login again.",
  ],
  authorization_timeout: [2, "ChatGPT authorization timed out. Run howto --chatgpt-login again."],
  invalid_callback_port: [2, "The ChatGPT callback port must be an integer from 1 to 65535."],
  callback_port_unavailable: [
    2,
    "Could not listen on the ChatGPT callback port. Choose another --callback-port and update any SSH port forwarding to match.",
  ],
  invalid_identity: [2, "ChatGPT identity validation failed. The saved account was not replaced."],
  invalid_response: [1, "ChatGPT returned an invalid authentication response."],
  session_changed: [
    2,
    "The ChatGPT session changed during sign-in. Run howto --chatgpt-login again.",
  ],
  refresh_invalid: [
    2,
    "The ChatGPT session needs to be renewed. Run howto --chatgpt-login for this account.",
  ],
  invalid_client: [
    2,
    "The saved ChatGPT registration could not be used. Check the account registration.",
  ],
  network: [1, "Could not reach ChatGPT. Check the connection and try again."],
  policy: [1, "ChatGPT denied this request. Check the account's app access and workspace policy."],
  ineligible: [1, "This ChatGPT account is not eligible to share plan usage with this app."],
  quota: [1, "ChatGPT usage limit reached. Review this app's limit in ChatGPT Settings > Usage."],
  unavailable: [1, "ChatGPT is temporarily unavailable. Try again later."],
  unsupported: [1, "This request is not supported by ChatGPT plan usage."],
} as const;

export type ChatGptErrorCode = keyof typeof MESSAGES;

export class ChatGptError extends Error {
  readonly exitCode: number;
  constructor(readonly code: ChatGptErrorCode) {
    super(MESSAGES[code][1]);
    this.name = "ChatGptError";
    this.exitCode = MESSAGES[code][0];
  }
}

export const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function classifyChatGptHttpError(status: number, code?: string): ChatGptError {
  code = code?.replace(/^subscription_sharing_/, "");
  if (
    status !== 401 &&
    status !== 429 &&
    [
      "model_not_found",
      "model_not_available",
      "model_unavailable",
      "unsupported_model",
      "model_not_supported",
    ].includes(code ?? "")
  )
    return new ChatGptError("model_unavailable");
  if (
    status !== 401 &&
    status !== 429 &&
    (code === "unsupported_service_tier" ||
      code === "service_tier_not_supported" ||
      code === "service_tier_not_allowed")
  )
    return new ChatGptError("fast_unsupported");
  if (code === "user_not_eligible") return new ChatGptError("ineligible");
  if (code === "usage_limit_exceeded" || status === 429) return new ChatGptError("quota");
  if (code === "unsupported_capability" || code === "route_not_supported")
    return new ChatGptError("unsupported");
  if (code === "invalid_client") return new ChatGptError("invalid_client");
  if (TERMINAL_REFRESH_ERRORS.has(code ?? "")) return new ChatGptError("refresh_invalid");
  if (code === "invalid_user") return new ChatGptError("login_required");
  if (code === "usage_unavailable" || code === "user_unavailable")
    return new ChatGptError("unavailable");
  if (code === "chatpass_v2_scope_not_authorized") return new ChatGptError("plan_permission");
  if (code === "chatpass_v2_invalid_authorization_context") return new ChatGptError("policy");
  if (status >= 500) return new ChatGptError("unavailable");
  if (status === 401) return new ChatGptError("login_required");
  if (status === 400) return new ChatGptError("unsupported");
  return new ChatGptError("policy");
}
