import assert from "node:assert/strict";
import test from "node:test";

import { AiProviderError } from "../../src/ai/index.js";
import { CliParseError, USAGE } from "../../src/cli.js";
import { ConfigError } from "../../src/config.js";
import {
  AppError,
  getUserVisibleErrorMessage,
  sanitizeUserVisibleErrorMessage,
  toAppError,
} from "../../src/errors.js";
import { InteractionCancelledError, InteractiveTtyError } from "../../src/ui/tty.js";
import { PlaceholderResolutionError } from "../../src/ui/placeholder-logic.js";
import { AiResponseValidationError } from "../../src/validation/ai-response.js";

const ATTACK_MESSAGE =
  "left\r\nright\u001B[2J api_key: secret-value Authorization: authorization-secret";
const SAFE_DYNAMIC_MESSAGE = "left␍␊right�[2J api_key: [redacted]";

test("sanitizeUserVisibleErrorMessage neutralizes controls before single-line redaction", () => {
  assert.equal(sanitizeUserVisibleErrorMessage(ATTACK_MESSAGE), SAFE_DYNAMIC_MESSAGE);
  const longMessage = `ordinary\t${"x".repeat(230)}`;
  assert.equal(sanitizeUserVisibleErrorMessage(longMessage).length, 220);
  assert.equal(sanitizeUserVisibleErrorMessage(longMessage).endsWith("..."), true);
});

test("sanitizeUserVisibleErrorMessage cannot be bypassed with terminal markers or auth schemes", () => {
  const cases = [
    {
      input: "api_key:\u001BAPI_SECRET_SENTINEL",
      expected: "api_key:�[redacted]",
      secret: "API_SECRET_SENTINEL",
    },
    {
      input: "api_\rkey: API_SECRET_SENTINEL",
      expected: "api_␍key: [redacted]",
      secret: "API_SECRET_SENTINEL",
    },
    {
      input: "Authorization: Basic dXNlci1zZWNyZXQ=",
      expected: "Authorization: [redacted]",
      secret: "dXNlci1zZWNyZXQ=",
    },
    {
      input: "Authorization:\nBa\u001Bsic dXNlci1zZWNyZXQ=",
      expected: "Authorization:␊[redacted]",
      secret: "dXNlci1zZWNyZXQ=",
    },
    {
      input: "api_key:\u001B[31mAPI_SECRET_SENTINEL",
      expected: "api_key:�[redacted]",
      secret: "API_SECRET_SENTINEL",
    },
    {
      input: "api_key:\u001B[31; 1mAPI_SECRET_SENTINEL",
      expected: "api_key:�[redacted]",
      secret: "API_SECRET_SENTINEL",
    },
    {
      input: "Authorization: Basic \u001B[31mAUTH_SECRET_SENTINEL",
      expected: "Authorization: [redacted]",
      secret: "AUTH_SECRET_SENTINEL",
    },
    {
      input: "Authorization: Basic \u001B[31; 1mAUTH_SECRET_SENTINEL",
      expected: "Authorization: [redacted]",
      secret: "AUTH_SECRET_SENTINEL",
    },
    {
      input: "Bea\u001Brer bearer-secret",
      expected: "Bearer [redacted]",
      secret: "bearer-secret",
    },
    {
      input: "Bearer \u001B[31; 1mBEARER_SECRET_SENTINEL",
      expected: "Bearer [redacted]",
      secret: "BEARER_SECRET_SENTINEL",
    },
  ];

  for (const { input, expected, secret } of cases) {
    const sanitized = sanitizeUserVisibleErrorMessage(input);

    assert.equal(sanitized, expected, input);
    assert.equal(sanitized.includes(secret), false, input);
  }
});

test("sanitizeUserVisibleErrorMessage removes URL credentials and parameters", () => {
  const message =
    "request failed at ht\u001Btp://user:PASSWORD_SENTINEL@example.test/v1?token=QUERY_SENTINEL#FRAGMENT_SENTINEL";
  const sanitized = sanitizeUserVisibleErrorMessage(message);

  assert.equal(sanitized, "request failed at [redacted URL]");
  for (const secret of [
    "user",
    "PASSWORD_SENTINEL",
    "example.test",
    "QUERY_SENTINEL",
    "FRAGMENT_SENTINEL",
  ]) {
    assert.equal(sanitized.includes(secret), false, secret);
  }
});

test("sanitizeUserVisibleErrorMessage preserves API key option names without credentials", () => {
  const message = "Gemini provider requires --gemini-api-key or HOWTO_GEMINI_API_KEY";

  assert.equal(sanitizeUserVisibleErrorMessage(message), message);
});

test("composite credential labels are redacted across user-visible error exits", () => {
  for (const { input, expected, secret } of [
    {
      input: "HOWTO_GEMINI_API_KEY: ENV_SECRET_SENTINEL",
      expected: "HOWTO_GEMINI_API_KEY: [redacted]",
      secret: "ENV_SECRET_SENTINEL",
    },
    {
      input: "OPENAI_API_KEY=OPENAI_SECRET_SENTINEL",
      expected: "OPENAI_API_KEY=[redacted]",
      secret: "OPENAI_SECRET_SENTINEL",
    },
    {
      input: "openaiApiKey: CAMEL_SECRET_SENTINEL",
      expected: "openaiApiKey: [redacted]",
      secret: "CAMEL_SECRET_SENTINEL",
    },
    {
      input: "HTTP_AUTHORIZATION: Basic AUTH_SECRET_SENTINEL",
      expected: "HTTP_AUTHORIZATION: [redacted]",
      secret: "AUTH_SECRET_SENTINEL",
    },
    {
      input: "--gemini-api-key=OPTION_SECRET_SENTINEL",
      expected: "--gemini-api-key=[redacted]",
      secret: "OPTION_SECRET_SENTINEL",
    },
  ]) {
    const messages = [
      sanitizeUserVisibleErrorMessage(input),
      getUserVisibleErrorMessage(new Error(input)),
      toAppError(new AppError(input, 7)).message,
    ];

    for (const message of messages) {
      assert.equal(message, expected, input);
      assert.equal(message.includes(secret), false, input);
    }
  }
});

test("sanitizeUserVisibleErrorMessage is idempotent after redaction", () => {
  const message = "request failed with api_key: secret";
  const sanitized = "request failed with api_key: [redacted]";

  assert.equal(sanitizeUserVisibleErrorMessage(message), sanitized);
  assert.equal(sanitizeUserVisibleErrorMessage(sanitized), sanitized);
});

test("sanitizeUserVisibleErrorMessage preserves no untrusted credential suffix", () => {
  for (const { input, expected } of [
    { input: "api_key: !!!", expected: "api_key: [redacted]" },
    { input: "Authorization: !!!", expected: "Authorization: [redacted]" },
    { input: "Bearer !!!", expected: "Bearer [redacted]" },
    { input: "https://!!!", expected: "[redacted URL]" },
  ]) {
    const sanitized = sanitizeUserVisibleErrorMessage(input);

    assert.equal(sanitized, expected, input);
    assert.equal(sanitized.includes("!!!"), false, input);
  }
});

test("toAppError sanitizes every known dynamic error category", () => {
  const cases: Array<{ name: string; error: unknown; exitCode: number; prefix: string }> = [
    {
      name: "AppError",
      error: new AppError(ATTACK_MESSAGE, 7),
      exitCode: 7,
      prefix: "",
    },
    {
      name: "ConfigError",
      error: new ConfigError(ATTACK_MESSAGE),
      exitCode: 2,
      prefix: "Configuration error: ",
    },
    {
      name: "AiResponseValidationError",
      error: new AiResponseValidationError(ATTACK_MESSAGE),
      exitCode: 2,
      prefix: "AI response format error: ",
    },
    {
      name: "InteractiveTtyError",
      error: new InteractiveTtyError(ATTACK_MESSAGE),
      exitCode: 2,
      prefix: "Error: ",
    },
    {
      name: "PlaceholderResolutionError",
      error: new PlaceholderResolutionError(ATTACK_MESSAGE),
      exitCode: 2,
      prefix: "Error: ",
    },
  ];

  for (const { name, error, exitCode, prefix } of cases) {
    const appError = toAppError(error);

    assert.equal(appError.exitCode, exitCode, name);
    assert.equal(appError.message, `${prefix}${SAFE_DYNAMIC_MESSAGE}`, name);
    assert.equal(appError.message.includes("\r"), false, name);
    assert.equal(appError.message.includes("\n"), false, name);
    assert.equal(appError.message.includes("\u001B"), false, name);
    assert.equal(appError.message.includes("secret-value"), false, name);
    assert.equal(appError.message.includes("authorization-secret"), false, name);
  }
});

test("toAppError sanitizes the usage error fragment before appending trusted layout", () => {
  const appError = toAppError(new CliParseError(ATTACK_MESSAGE));

  assert.equal(appError.exitCode, 2);
  assert.equal(appError.message, `Error: ${SAFE_DYNAMIC_MESSAGE}\n${USAGE}`);
  assert.equal(appError.message.includes("\u001B"), false);
  assert.equal(appError.message.includes("secret-value"), false);
  assert.match(appError.message, /\nUsage: howto [^\n]+\n {7}howto --init\n/u);
});

test("toAppError maps provider failures with a safe message and raw model metadata", () => {
  const maliciousModel = "model-left\r\nmodel-right\u001B[2J api_key: model-secret";
  const providerError = new AiProviderError("openai", maliciousModel);
  const appError = toAppError(providerError);

  assert.equal(providerError.model, maliciousModel);
  assert.equal(
    providerError.message,
    "AI provider request failed (provider: openai, model: model-left␍␊model-right�[2J api_key: [redacted])",
  );
  assert.equal(appError.exitCode, 1);
  assert.equal(appError.message, providerError.message);
  assert.equal(appError.message.includes("\r"), false);
  assert.equal(appError.message.includes("\n"), false);
  assert.equal(appError.message.includes("\u001B"), false);
  assert.equal(appError.message.includes("model-secret"), false);
});

test("toAppError maps normal provider failures to the existing fixed format", () => {
  for (const { provider, model } of [
    { provider: "openai", model: "gpt-test" },
    { provider: "gemini", model: "gemini-test" },
  ] as const) {
    const appError = toAppError(new AiProviderError(provider, model));

    assert.equal(appError.exitCode, 1);
    assert.equal(
      appError.message,
      `AI provider request failed (provider: ${provider}, model: ${model})`,
    );
  }
});

test("toAppError sanitizes unknown Error and string values and ignores object details", () => {
  for (const error of [new Error(ATTACK_MESSAGE), ATTACK_MESSAGE]) {
    const appError = toAppError(error);

    assert.equal(appError.exitCode, 1);
    assert.equal(appError.message, `Error: ${SAFE_DYNAMIC_MESSAGE}`);
  }

  const opaque = toAppError({ message: ATTACK_MESSAGE });
  assert.equal(opaque.exitCode, 1);
  assert.equal(opaque.message, "Error: unknown error");
});

test("toAppError maps user cancellation to exit code 130 without output", () => {
  const appError = toAppError(new InteractionCancelledError(ATTACK_MESSAGE));

  assert.equal(appError.exitCode, 130);
  assert.equal(appError.message, "");
});
