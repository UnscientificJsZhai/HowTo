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

Requires **Node.js 22 or newer**. The npm package declares this through `engines.node`, matching the minimum version required by its existing runtime dependencies.

Only **macOS and Linux** are supported. Native Windows is unsupported, including CMD, PowerShell, and Git Bash/MSYS2 using Windows Node.js. WSL requires Node.js installed and running inside Linux; dedicated WSL acceptance testing has not been completed. Both npm installation and CLI startup check the operating system.

Interactive execution only supports `sh`, `bash`, and `zsh`. `SHELL` may be one of these bare names or an absolute path with one of these filenames, such as `/bin/zsh` or `/opt/homebrew/bin/bash`; relative paths and additional arguments are rejected. A missing or whitespace-only `SHELL` defaults to `/bin/sh`, including the system-provided `/bin/sh` symlink. Other shells are rejected before initialization or AI requests, without silently switching interpreters; the check runs again immediately before execution. To select an execution shell explicitly, use `env SHELL=/bin/bash howto "list files"`.

`--print`, `--init`, and `--version` do not execute candidate commands, so they check the operating system but do not restrict `SHELL`. Unsupported operating systems or execution shells return exit code `2`. This restriction applies to the outer interpreter launched by howto, not programs launched by candidate commands, and does not provide a sandbox.

Install the CLI package globally:

```bash
npm install -g @unscientificjszhai/howto
```

Or run it from a cloned repository:

```bash
npm ci
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

Initialization and placeholder input delete complete characters on Backspace, including emoji and combining sequences. Alt/Meta shortcuts are not inserted into configuration fields as text.
Key release events never confirm, cancel, navigate, or delete; pressing and releasing Enter once cannot skip the final confirmation.
Keyboard text and Enter are processed in order even when the terminal delivers them together. Once a step finishes, remaining keys in that batch cannot skip the next confirmation screen. Newlines inside paste remain data.

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

OpenAI Authorization uses the key configured in howto and is omitted when that key is blank. Authorization in `OPENAI_CUSTOM_HEADERS` cannot override this choice. Interactive OpenAI requests report rate limits and temporary service errors without automatic retries so cancellation can exit promptly; `--print` keeps the SDK's default retry behavior.

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
- all placeholders use `{{name}}` syntax and are declared consistently, with each name declared once per candidate and repeated references sharing one input value;
- `use <command>` candidates clearly start with the requested tool after conservative prefix handling;
- commands flagged by local checks, inconclusive local analysis, or AI require typing `EXECUTE` before they can run; matching is case-insensitive.

In the same request that generates candidates, AI must return a boolean `dangerous` and a string `dangerReason` for each candidate. A flagged command requires a brief, non-whitespace reason; an unflagged command requires exactly `""`. Missing fields, incorrect types, or inconsistent combinations reject the entire response with exit code `2`, including older responses without these fields. Both providers and output modes use the same contract.

The prompt asks AI to assess complete commands for data loss, important data overwrites, destructive history changes, system or permission changes, service disruption, sensitive information disclosure, and untrusted code execution, supplementing operations local rules may miss. Ordinary queries, file creation, and routine builds are not automatically flagged merely because they have side effects.

Final confirmation always checks the command after placeholder substitution and retains the original candidate's AI flag. An AI false flag cannot lower a local danger or inconclusive result. AI-only risks show `AI: <reason>`; when both checks flag a command, the local reason is preserved and the AI reason is appended. Filling placeholders does not trigger another AI request or send the entered values. `--print` validates these fields while continuing to output only commands.

Dangerous-command detection currently covers high-risk patterns such as recursive destructive `rm`, disk and filesystem operations, broad recursive permission changes, downloaded scripts piped into a shell, high-impact package manager operations, and service changes.

Local analysis handles literal quoting, absolute command paths, and supported `sudo`/`env` options, and checks each command segment. Unknown wrapper options, dynamic executable prefixes, and shell syntax outside the supported subset also require `EXECUTE`, so an inconclusive analysis does not skip the additional confirmation.

Command bodies passed to `ash` or `hush`, and BusyBox applet dispatch, conservatively require additional confirmation, including calls such as `busybox ls` whose applets are not analyzed. The outer execution shell remains limited to sh/bash/zsh.

Line continuations within numeric file descriptors require additional confirmation and are rejected by `use` because shells interpret them differently. Risk analysis recognizes high-risk paths with redundant dots or slashes, such as `./../important` and `///dev/disk2`, without collapsing `..` or changing the command that runs.

Assignments passed to `env` can use names starting with digits or containing hyphens or dots; the actual command after them is still checked. Official npm global install/uninstall aliases such as `i`, `add`, `un`, and `unlink` receive the same additional confirmation. Inconclusive abbreviations of those actions also require confirmation.
Leading `NAME+=value` requires additional confirmation and is rejected by `use` because its meaning differs between shells. Dollar expressions outside single quotes or backslash protection are treated conservatively as dynamic values. Compound npm installs through `install-test`, `installTest`, `it`, and their abbreviations also receive global-install checks.

Homebrew uninstall aliases such as `rm/uninstal`, and yum/dnf upgrade or removal commands such as `update/erase`, receive the same additional confirmation. Actions are interpreted separately for each tool; metadata updates through `apt update` and `brew update/up` are not classified as system package upgrades.

Linux checks also cover system package changes through apk, pacman, and zypper, and OpenRC service or runlevel changes, such as `apk upgrade`, `pacman -Syu`, `zypper dup`, `rc-service sshd stop`, and `rc-update del sshd`. Common queries and apk/zypper metadata refreshes keep ordinary confirmation; unsupported options, dynamic arguments, and additional service commands conservatively require `EXECUTE`. Query arguments are also checked: `zypper repos --export …`, which writes to a file, still requires additional confirmation.

If howto detects bracketed paste during an interactive run, including automatic initialization, that run permanently switches to printing the final command for manual execution. At final confirmation, Enter prints the command without running it, and the terminal shows an explanation. Returning to selection or resizing the terminal does not restore execution. Keyboard-only runs keep the usual Enter or `EXECUTE` confirmation.

Paste spanning a hidden terminal view is discarded as a whole. These rules apply to recognized bracketed-paste input; the terminal protocol cannot authenticate arbitrary pasted keystrokes or embedded end markers. The execution restriction applies to howto's own command launch.

> [!WARNING]
> A command that passes local checks and is not flagged by AI is not guaranteed to be safe. These checks add confirmation requirements; they do not provide a complete safety proof or guarantee AI assessment accuracy.

## Development

This project is built with TypeScript, React, Ink, OpenAI SDK, Gemini GenAI SDK, and Node's built-in test runner.

For development and the full test suite, use **Node.js 22.x (22.22.1 or later) or 24.x (24.3.0 or later)**. These versions satisfy the development dependencies and execute the TypeScript release-validation script directly without experimental warnings.

```bash
npm ci
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

### Linux validation

The 1.0.2 local validation used Debian 13.6 x86_64 in a Cloud container, Node 22.22.1 / 24.19.0, and real kernel PTYs with dash (`/bin/sh`), bash 5.2.37 and zsh 5.9. Both Node versions passed 719 tests without skips, including 42 PTY cases; stability rounds and additional boundary evidence are recorded in the validation report. The installed package was checked separately on Node 22.0.0 with npm 10.5.1. Evidence, fixes and coverage limits are recorded in the validation report delivered separately with this task.

The full POSIX suite requires Python 3 available on `/usr/bin:/bin`, sh/bash/zsh, an allocatable PTY, and a non-root user for permission checks. Some Linux process-group checks use a subprocess supervisor and are explicitly inapplicable to macOS. Tests use isolated temporary homes and fake providers; they do not require API keys. To verify a separately installed package, run `npm run test:package -- /absolute/path/to/bin/howto`; this compiles and runs `tests/package-smoke.ts`, uses a local HTTP fixture, and only executes a harmless print command after confirmation. CI uploads the compiled smoke entry alongside the candidate package so the minimum-Node package check requires no development dependencies.

The CI configuration adds Ubuntu 24.04 with Node 22.22.1 / 24.19.0, macOS 14 regression, and installed-package checks on Node 22.0.0 / 24.19.0. These jobs were not run remotely in this local task. Alpine, native arm64, WSL, and real terminal-emulator visuals remain unverified; a PTY or a configured job is not evidence for those platforms. A separate environment passed bounded live Gemini native and OpenAI-compatible protocol smoke checks; native structured-output OFF, the default model, and the full live CLI remain unverified.

## Troubleshooting

### Linux terminal and output failures

Linux interactive handoff requires access to `/proc/self/fd/0` to check pasted bytes still queued in the kernel. A read failure prevents execution. The corresponding macOS kernel-queue boundary still requires dedicated validation.

Both stdin and stdout must be TTYs for interactive mode and `--init`. Use `--print` when either stream is redirected. A closed stdout pipe now exits with status 1 and a fixed error message; do not treat truncated output as successful delivery. If PTY tests cannot find Python, check `PATH=/usr/bin:/bin python3 --version`; CI treats missing prerequisites and Linux test skips as failures.

HowTo invokes the selected shell with `-c`, not as a login shell. This does not promise a clean environment: shell startup files and inherited variables can affect commands. Configuration files are written atomically with mode 0600; existing directory permissions and symlinks are preserved. Protect the configuration directory and its parent from other users, especially with a permissive umask.

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
