# howto

_Use AI to quickly find commands within the terminal._

[![npm version](https://img.shields.io/npm/v/@unscientificjszhai/howto/latest)](https://www.npmjs.com/package/@unscientificjszhai/howto)
[![GitHub Actions Test Status](https://github.com/UnscientificJsZhai/HowTo/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/UnscientificJsZhai/HowTo/actions)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![License](https://img.shields.io/github/license/UnscientificJsZhai/HowTo)](LICENSE)

English | [简体中文](README.CN.md)

[Features](#features) • [Install](#install) • [Usage](#usage) • [Configuration](#configuration) • [Development](#development) • [Troubleshooting](#troubleshooting)

`howto` is a TypeScript CLI that turns a natural-language question into up to three executable command candidates. It never runs AI output directly: you choose a command in the terminal, fill any placeholders, review the final command, and confirm before execution.

> [!IMPORTANT]
> `howto` is an assistant for generating shell commands, not a sandbox. Review every command before running it, especially commands that modify files, install packages, change permissions, or use elevated privileges.

## Features

- **Natural language to commands** - ask for a task and get concise shell command candidates.
- **Tool-constrained mode** - use `howto use <command>` to require candidates around a specific CLI tool.
- **Interactive review flow** - select a candidate, resolve placeholders, and confirm the final command before execution.
- **Non-interactive print mode** - use `--print` to output candidates without TTY interaction or command execution.
- **OpenAI and Gemini support** - configure either provider from CLI flags, environment variables, or `~/.howto/config.json`.
- **Local validation first** - AI JSON output, placeholder references, `use <command>` candidates, and obvious dangerous commands are checked locally.

## Install

Install the CLI package globally:

```bash
npm install -g @unscientificjszhai/howto
```

Or run it from a cloned repository:

```bash
npm install
npm run build
npm link
```

You can then call the executable as `howto`.

## Getting Started

Initialize your AI provider configuration:

```bash
howto --init
```

The initializer writes a user-level config file at `~/.howto/config.json`.

> [!NOTE]
> OpenAI API keys may be empty for local OpenAI-compatible services. Gemini requires a non-empty API key.

Ask for a command:

```bash
howto "find files modified in the last 7 days" .
```

Limit candidates to a specific tool:

```bash
howto use git "show commits from last week"
```

`use` checks the first actual tool exactly after environment assignments and supported `sudo`/`env` options. For example, `sudo -u root git status` satisfies `use git`, while `sudo -u git id` does not. Unknown wrapper options, missing option values, dynamic executable prefixes, and complex shell structures are rejected. This constraint applies to the first command segment, not subsequent segments.

Declared placeholders may appear after the first tool, as in `git log -n {{count}}`. The tool name and preceding prefixes must be identifiable before placeholder resolution. Template analysis does not change the command text.

Print command candidates without entering the interactive UI:

```bash
howto --print "list the largest files" /var/log
```

## Usage

```text
howto [options] [use <command>] <question> [<argument>...]
howto --init
howto --version
```

Examples:

```bash
howto "find package.json under the current directory"
howto use find "find a filename" package.json
howto "explain this option" -- --force
howto --ai-provider openai --print "show listening ports"
```

Options:

- `--init` - start interactive provider setup and save `~/.howto/config.json`.
- `--version` - use alone to print the current package version and exit successfully; requires no configuration or TTY and makes no AI request.
- `--print` - print validated command candidates and exit without executing.
- `--ai-provider <openai|gemini>` - select the AI provider.
- `--gemini-api-key <key>` - provide a Gemini API key.
- `--gemini-model <model>` - override the Gemini model.
- `--openai-api-url <url>` - use a custom OpenAI-compatible base URL.
- `--openai-api-key <key>` - provide an OpenAI API key.
- `--openai-model <model>` - override the OpenAI model.
- `--structured-output <true|false>` - enable SDK-level schema structured output; default `true`.

### Argument Parsing

`question` is one shell argument. Quote it when it contains spaces:

```bash
howto "find recently changed files" /tmp
```

Everything after the question is passed to the AI as `argument[]`. Use `--` when an argument starts with `--`:

```bash
howto "explain this flag" -- --force
```

## Configuration

Configuration is resolved in this order:

1. CLI options
2. Environment variables
3. `~/.howto/config.json`
4. Built-in defaults

The config path uses `HOME` when it is an absolute path. If `HOME` is missing or blank, howto queries the operating system for the user's home directory. A non-empty relative `HOME` or a failed system lookup produces a configuration error before any file is created.

For each setting, the first configured source in that order wins:

- `--ai-provider` / `HOWTO_AI_PROVIDER` / `aiProvider` - `openai` or `gemini`; no default.
- `--gemini-api-key` / `HOWTO_GEMINI_API_KEY` / `geminiApiKey` - Gemini API key; required for Gemini.
- `--gemini-model` / `HOWTO_GEMINI_MODEL` / `geminiModel` - Gemini model; default `gemini-3.1-flash-lite`.
- `--openai-api-url` / `HOWTO_OPENAI_API_URL` / `openaiApiUrl` - OpenAI-compatible base URL; defaults to `https://api.openai.com/v1`.
- `--openai-api-key` / `HOWTO_OPENAI_API_KEY` / `openaiApiKey` - OpenAI API key; defaults to an empty string for local services.
- `--openai-model` / `HOWTO_OPENAI_MODEL` / `openaiModel` - OpenAI model; default `gpt-5.4-mini`.
- `--structured-output` / `HOWTO_STRUCTURED_OUTPUT` / `structuredOutput` - use provider schema structured output; default `true`.

howto sets the request endpoint and Gemini API mode explicitly. `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`, and the Google SDK's Vertex/Enterprise environment switches do not override them. Gemini uses the official `generativelanguage.googleapis.com` `v1beta` API. Use the HOWTO settings above for a custom OpenAI endpoint.

Example:

```bash
HOWTO_AI_PROVIDER=openai \
HOWTO_OPENAI_MODEL=gpt-5.4-mini \
howto --print "show current branch"
```

## Safety Model

`howto` treats AI output as untrusted data. Before anything reaches execution, the CLI checks that:

- the AI response is valid JSON matching the required command schema;
- the response contains between one and three candidates;
- all placeholders use `{{name}}` syntax and are declared consistently;
- `use <command>` candidates clearly start with the requested tool after conservative prefix handling;
- obvious dangerous patterns require typing `EXECUTE` before they can run; matching is case-insensitive.

Dangerous-command detection currently covers high-risk patterns such as recursive destructive `rm`, disk and filesystem operations, broad recursive permission changes, downloaded scripts piped into a shell, high-impact package manager operations, and service changes.

Local analysis handles literal quoting, absolute command paths, and supported `sudo`/`env` options, and checks each command segment. Unknown wrapper options, dynamic executable prefixes, and shell syntax outside the supported subset also require `EXECUTE`, so an inconclusive analysis does not skip the additional confirmation.

If howto detects bracketed paste during an interactive run, including automatic initialization, that run permanently switches to printing the final command for manual execution. At final confirmation, Enter prints the command without running it, and the terminal shows an explanation. Returning to selection or resizing the terminal does not restore execution. Keyboard-only runs keep the usual Enter or `EXECUTE` confirmation.

Paste spanning a hidden terminal view is discarded as a whole. These rules apply to recognized bracketed-paste input; the terminal protocol cannot authenticate arbitrary pasted keystrokes or embedded end markers. The execution restriction applies to howto's own command launch.

> [!WARNING]
> A command not flagged as dangerous is not guaranteed to be safe. The local checks add confirmation for known high-risk patterns and syntax they cannot analyze; they do not prove command safety.

## Development

This project is built with TypeScript, React, Ink, OpenAI SDK, Gemini GenAI SDK, and Node's built-in test runner.

```bash
npm install
npm run build
npm test
npm run lint
npm run format:check
```

Useful paths:

- `src/index.tsx` - CLI orchestration and execution flow.
- `src/cli.ts` - argument parsing.
- `src/config.ts` - config merging and provider validation.
- `src/prompt.ts` - prompt and AI output contract.
- `src/validation/` - AI response and command-tool validation.
- `src/safety/` - dangerous command rules.
- `src/ui/` - Ink-based terminal UI.
- `tests/unit/` - unit tests for CLI, config, validation, execution, UI, and safety logic.

## Troubleshooting

### AI provider is not configured

Run:

```bash
howto --init
```

For `--print`, initialization is intentionally skipped. Configure the provider first or pass the relevant CLI flags/environment variables.

### Non-interactive terminal error

The default mode needs an interactive TTY for selection and confirmation. Use `--print` in scripts or CI:

```bash
howto --print "show disk usage"
```

### Gemini key is required

Gemini cannot run without an API key. Set `HOWTO_GEMINI_API_KEY`, pass `--gemini-api-key`, or rerun `howto --init`.
