import assert from "node:assert/strict";
import test from "node:test";

import { AiProviderError } from "../../src/ai/index.js";
import { CliParseError } from "../../src/cli.js";
import { ConfigError } from "../../src/config.js";
import { AppError, toAppError } from "../../src/errors.js";
import { InteractionCancelledError, InteractiveTtyError } from "../../src/ui/tty.js";
import { PlaceholderResolutionError } from "../../src/ui/placeholder-logic.js";
import { AiResponseValidationError } from "../../src/validation/ai-response.js";

test("toAppError keeps existing AppError instances", () => {
  const error = new AppError("already mapped", 7);

  assert.equal(toAppError(error), error);
});

test("toAppError maps usage and validation failures to exit code 2", () => {
  assert.equal(toAppError(new CliParseError("missing question")).exitCode, 2);
  assert.match(toAppError(new CliParseError("missing question")).message, /Usage: howto/);

  assert.equal(toAppError(new ConfigError("invalid provider")).exitCode, 2);
  assert.equal(toAppError(new AiResponseValidationError("not JSON")).exitCode, 2);
  assert.equal(toAppError(new InteractiveTtyError()).exitCode, 2);
  assert.equal(toAppError(new PlaceholderResolutionError("unresolved")).exitCode, 2);
});

test("toAppError maps provider failures to fixed messages with provider and model", () => {
  const cases = [
    {
      provider: "openai",
      model: "gpt-test",
      message: "AI provider request failed (provider: openai, model: gpt-test)",
    },
    {
      provider: "gemini",
      model: "gemini-test",
      message: "AI provider request failed (provider: gemini, model: gemini-test)",
    },
  ] as const;

  for (const { provider, model, message } of cases) {
    const appError = toAppError(new AiProviderError(provider, model));

    assert.equal(appError.exitCode, 1);
    assert.equal(appError.message, message);
  }
});

test("toAppError maps user cancellation to exit code 130 without output", () => {
  const appError = toAppError(new InteractionCancelledError());

  assert.equal(appError.exitCode, 130);
  assert.equal(appError.message, "");
});

test("toAppError redacts sensitive material from unknown errors", () => {
  const appError = toAppError(
    new Error("failed with Authorization: sk-secret-token and api_key: abc123"),
  );

  assert.equal(appError.exitCode, 1);
  assert.doesNotMatch(appError.message, /sk-secret-token/);
  assert.doesNotMatch(appError.message, /abc123/);
  assert.match(appError.message, /Authorization: \[redacted]/i);
  assert.match(appError.message, /api_key: \[redacted]/i);
});
