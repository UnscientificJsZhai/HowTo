# howto

_Use AI to quickly find commands within the terminal._

[![npm version](https://img.shields.io/npm/v/@unscientificjszhai/howto/latest)](https://www.npmjs.com/package/@unscientificjszhai/howto)
[![GitHub Actions Test Status](https://github.com/UnscientificJsZhai/HowTo/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/UnscientificJsZhai/HowTo/actions)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![License](https://img.shields.io/github/license/UnscientificJsZhai/HowTo)](LICENSE)

English | [简体中文](README.zh-hans-cn.md)

[Features](#features) • [Install](#install) • [Usage](#usage) • [Configuration](#configuration) • [Development](#development) • [Troubleshooting](#troubleshooting)

`howto` is a TypeScript CLI that turns a natural-language question into up to three executable command candidates. It never runs AI output directly: you choose a command in the terminal, fill any placeholders, review the final command, and confirm before execution.

> [!IMPORTANT]
> `howto` is an assistant for generating shell commands, not a sandbox. Review every command before running it, especially commands that modify files, install packages, change permissions, or use elevated privileges.

## Features

- **Natural language to commands** - ask for a task and get concise shell command candidates.
- **Tool-constrained mode** - use `howto use <command>` to require candidates around a specific CLI tool.
- **Interactive review flow** - select a candidate, resolve placeholders, and confirm the final command before execution.
- **Non-interactive print mode** - use `--print` to output candidates without TTY interaction or command execution.
- **ChatGPT, OpenAI, and Gemini support** - sign in with ChatGPT to use an eligible plan, or keep using API keys and OpenAI-compatible services.
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

Choose **Continue with ChatGPT** to sign in through the system browser, select a saved account or add one, and choose a model from that account's live catalog. The official open-source Sign in with ChatGPT flow uses a local callback on `127.0.0.1`. It requires neither a client secret nor a Codex installation. Existing API key settings are preserved when switching providers.

For account management outside initialization:

```bash
howto --chatgpt-login
howto --chatgpt-status
howto --chatgpt-models --chatgpt-account <account-id>
howto --chatgpt-login --chatgpt-account <account-id>
howto --chatgpt-logout --chatgpt-account <account-id>
```

Login without `--chatgpt-account` adds a registration; with an account ID it renews that registration. Login alone does not change the selected provider or model. Run `howto --init` to save those choices. Ordinary generation and `--print` never start browser authorization. ChatGPT uses the account's current visible model slugs; it never silently switches models or falls back to API key billing.

ChatGPT credentials are stored separately in `~/.howto/chatgpt/` (private directory, owner-only files), with serialized refresh and logout across processes. Tokens are never put in `config.json`. If a refresh response is lost, sign in again rather than replaying a potentially consumed refresh token. Logout retains the registration for later sign-in and reports when remote revocation was not confirmed. Review app usage and permissions in [ChatGPT Settings](https://chatgpt.com/settings/usage). Eligibility and available models depend on the account; see the [official open-source flow](https://developers.openai.com/siwc/token-sharing-open-source).

Initialization and placeholder input delete complete characters on Backspace, including emoji and combining sequences. Alt/Meta shortcuts are not inserted into configuration fields as text.
Key release events never confirm, cancel, navigate, or delete; pressing and releasing Enter once cannot skip the final confirmation.
Keyboard text and Enter are processed in order even when the terminal delivers them together. Once a step finishes, remaining keys in that batch cannot skip the next confirmation screen. Newlines inside paste remain data.

> [!NOTE]
> OpenAI API keys may be empty for local OpenAI-compatible services. Gemini requires a non-empty API key.

Ask for a command:

```bash
howto find files modified in the last 7 days under .
```

Limit candidates to a specific tool:

```bash
howto use git show commits from last week
```

`use` checks the first actual tool exactly after environment assignments and supported `sudo`/`env` options. For example, `sudo -u root git status` satisfies `use git`, while `sudo -u git id` does not. Unknown wrapper options, missing option values, dynamic executable prefixes, and complex shell structures are rejected. This constraint applies to the first command segment, not subsequent segments.

Declared placeholders may appear after the first tool, as in `git log -n {{count}}`. The tool name and preceding prefixes must be identifiable before placeholder resolution. Template analysis does not change the command text.

Print command candidates without entering the interactive UI:

```bash
howto --print list the largest files under /var/log
```

### ChatGPT login over SSH

On your computer with a browser, connect to the server with a loopback port forward:

```bash
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:1455:127.0.0.1:1455 user@server
```

In that remote shell, start login:

```bash
howto --chatgpt-login --no-browser --callback-port 1455
```

Open the printed authorization URL in your local browser. Keep both the SSH connection and HowTo running until login completes. Replace `user@server` with your SSH destination. The browser redirects to its own `127.0.0.1`; the tunnel forwards that callback to HowTo on the server. No public callback listener is needed. The server still needs outbound HTTPS access to OpenAI's authentication and API services.

To sign in and save your provider/model choices in one interactive session, run `howto --init --no-browser --callback-port 1455` instead, then choose **Continue with ChatGPT**. Initialization requires a TTY; the standalone login command does not.

Both options are optional and apply only to `--chatgpt-login` or `--init`, only for the current invocation. `--no-browser` skips the browser launcher entirely and prints a link even when renewing an existing account. `--callback-port` accepts a decimal integer from `1` to `65535`; without it, HowTo chooses an available port and prints forwarding instructions for that port. These options are not saved in configuration and do not affect API key providers.

If either end cannot bind the chosen port, choose another available port and use it on both ends of the tunnel and in `--callback-port`. HowTo does not silently change an explicitly requested port. If already connected over SSH, use the printed `ssh -N ...` command in another local terminal before opening the URL. Login waits up to 10 minutes; Ctrl+C cancels it and releases the callback listener. Once authenticated, ordinary requests and token refreshes need no browser. This flow still requires browser approval on your local computer; it does not use device codes or accept pasted callback URLs.

## Usage

```text
howto [options] [use <command>] <question...>
howto --init [--no-browser] [--callback-port <port>]
howto --version
howto --chatgpt-login [--chatgpt-account <id>] [--no-browser] [--callback-port <port>]
```

Examples:

```bash
howto find package.json under the current directory
howto use find find report.txt under /tmp
howto explain this option -- --force
howto --ai-provider openai --print show listening ports
```

Options:

- `--init` - start interactive provider setup and save `~/.howto/config.json`.
- `--version` - use alone to print the current package version and exit successfully; requires no configuration or TTY and makes no AI request.
- `--print` - print validated command candidates and exit without executing.
- `--ai-provider <openai|gemini|chatgpt>` - select the AI provider.
- `--chatgpt-account <id>` / `--chatgpt-model <slug>` - choose a local registration and an available ChatGPT model.
- `--no-browser` - skip the ChatGPT browser launcher and print the authorization URL; only with `--chatgpt-login` or `--init`.
- `--callback-port <port>` - use a specific ChatGPT loopback callback port (`1`–`65535`, random available port by default); only with `--chatgpt-login` or `--init`.
- `--gemini-api-key <key>` - provide a Gemini API key.
- `--gemini-model <model>` - override the Gemini model.
- `--openai-api-url <url>` - use a custom OpenAI-compatible base URL.
- `--openai-api-key <key>` - provide an OpenAI API key.
- `--openai-model <model>` - override the OpenAI model.
- `--structured-output <true|false>` - enable SDK-level schema structured output; default `true`.

### Argument Parsing

All question fragments are joined with one ASCII space. In `use` mode, the first positional token is `use`, the next is the tool name, and all remaining fragments form the question. Global options may appear anywhere before `--`; unknown long options are rejected. Everything after `--` is positional text.

| Input                                       | Final question               |
| ------------------------------------------- | ---------------------------- |
| `howto list files changed today`            | `list files changed today`   |
| `howto "list files" /tmp`                   | `list files /tmp`            |
| `howto use find find report.txt under /tmp` | `find report.txt under /tmp` |
| `howto list files --print`                  | `list files` (print mode)    |
| `howto explain -- --force`                  | `explain --force`            |
| `howto find files "/tmp/my files"`          | `find files /tmp/my files`   |
| `howto "" "   "`                            | Usage error                  |

Whitespace and line breaks inside each fragment are preserved. Missing or entirely whitespace questions exit with code `2` and Usage before configuration loading or AI requests. The question itself is never trimmed, and quotes or fragment boundaries are not reconstructed or sent separately.

The model infers paths, filenames, counts, and options from the complete question. Clear values become command parameters; required values that are missing or ambiguous become placeholders for the existing fill-and-confirm flow.

Quoted questions remain valid. Older “question + extra parameters” invocations now form one question, with no separate parameter grouping. Original shell argument boundaries cannot be recovered after joining, so paths containing spaces are interpreted from the question's meaning; describe their purpose clearly.

Unquoted input is convenient for ordinary question text. Your shell still processes variables, wildcards, redirections, and other special syntax before howto receives it; quote or escape these when you need literal text. Existing management actions and repeated-option rules are unchanged; no configuration migration is needed.

## Configuration

Configuration is resolved in this order:

1. CLI options
2. Environment variables
3. `~/.howto/config.json`
4. Built-in defaults

The config path uses `HOME` when it is an absolute path. If `HOME` is missing or blank, howto queries the operating system for the user's home directory. A non-empty relative `HOME` or a failed system lookup produces a configuration error before any file is created.

For each setting, the first configured source in that order wins:

- `--ai-provider` / `HOWTO_AI_PROVIDER` / `aiProvider` - `openai`, `gemini`, or `chatgpt`; no default.
- `--chatgpt-account` / `HOWTO_CHATGPT_ACCOUNT` / `chatgptAccount` - local ChatGPT registration ID; required when more than one account is saved.
- `--chatgpt-model` / `HOWTO_CHATGPT_MODEL` / `chatgptModel` - visible model slug from `--chatgpt-models`; no static default.
- `--gemini-api-key` / `HOWTO_GEMINI_API_KEY` / `geminiApiKey` - Gemini API key; required for Gemini.
- `--gemini-model` / `HOWTO_GEMINI_MODEL` / `geminiModel` - Gemini model; default `gemini-3.5-flash-lite`.
- `--openai-api-url` / `HOWTO_OPENAI_API_URL` / `openaiApiUrl` - OpenAI-compatible base URL; defaults to `https://api.openai.com/v1`.
- `--openai-api-key` / `HOWTO_OPENAI_API_KEY` / `openaiApiKey` - OpenAI API key; defaults to an empty string for local services.
- `--openai-model` / `HOWTO_OPENAI_MODEL` / `openaiModel` - OpenAI model; default `gpt-6-luna`.
- `--structured-output` / `HOWTO_STRUCTURED_OUTPUT` / `structuredOutput` - use provider schema structured output; default `true`.

howto sets the request endpoint and Gemini API mode explicitly. `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`, and the Google SDK's Vertex/Enterprise environment switches do not override them. Gemini uses the official `generativelanguage.googleapis.com` `v1beta` API. Use the HOWTO settings above for a custom OpenAI endpoint.

OpenAI Authorization uses the key configured in howto and is omitted when that key is blank. Authorization in `OPENAI_CUSTOM_HEADERS` cannot override this choice. Interactive OpenAI requests report rate limits and temporary service errors without automatic retries so cancellation can exit promptly; `--print` keeps the SDK's default retry behavior.

Example:

```bash
HOWTO_AI_PROVIDER=openai \
HOWTO_OPENAI_MODEL=gpt-6-luna \
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

Pasting does not disable command execution or `use` lookups. API key, placeholder, and query argument fields accept complete paste blocks; CR/LF remain data and never submit a field. Submitting a field discards remaining keys and pastes from that input batch. Selection, query approval, and final confirmation screens ignore paste. Type `EXECUTE` on the keyboard for dangerous commands; execution still requires a separate confirmation.

Paste containing unsupported control characters (including Tab), or spanning a field, screen, or hidden view, is discarded with an explanation. Each paste is limited to 256 KiB. An unfinished paste cancels the interaction after 5 seconds without new data or 30 seconds in total, restores the terminal, and exits with status 1 without executing a command.

These rules cover complete, valid bracketed paste. The terminal protocol cannot authenticate embedded end markers or delayed bytes after them, or reliably distinguish unframed paste from typing. Screen isolation does not guarantee that arbitrary forged protocol input cannot trigger execution.

> [!WARNING]
> A command that passes local checks and is not flagged by AI is not guaranteed to be safe. These checks add confirmation requirements; they do not provide a complete safety proof or guarantee AI assessment accuracy.

## Development

This project is built with TypeScript, React, Ink, OpenAI SDK, Gemini GenAI SDK, and Node's built-in test runner.

For development and the full test suite, use **Node.js 22.x (22.22.1 or later) or 24.x (24.3.0 or later)**. These versions satisfy the development dependencies.

Builds use TypeScript 7 through the `@typescript/native` npm alias. ESLint retains the TypeScript 6 JavaScript API through `typescript` → `@typescript/typescript6` (currently forwarding to 6.0.3), following the [official side-by-side setup](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0). Build scripts invoke the native compiler explicitly because incremental npm installs can change the shared `tsc` symlink. `npm run check:toolchain` verifies compiler versions, compatibility API resolution, and explicit build compiler paths. Run `npm run lint` to check project code with the existing type-aware rules. Keep both compilers compatible with the project until typescript-eslint supports the new API; this does not give ESLint TypeScript 7-only language support.

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
- `tests/unit/` - argument parsing, configuration merging, validation, prompts, pure UI logic and static rendering, and providers with dependency stubs.
- `tests/integration/` - filesystem and credential storage, real SDK serialization, Ink component interactions and complete UI flows, CLI processes, loopback HTTP providers, and PTY sessions.
- `tests/helpers/` - input streams, request data, and rendering helpers shared by both suites.

`npm test` runs both suites; use `npm run test:unit` or `npm run test:integration` to run one suite independently.

### Linux validation

The 1.0.2 local validation used Debian 13.6 x86_64 in a Cloud container, Node 22.22.1 / 24.19.0, and real kernel PTYs with dash (`/bin/sh`), bash 5.2.37 and zsh 5.9. Both Node versions passed 719 tests without skips, including 42 PTY cases; stability rounds and additional boundary evidence are recorded in the validation report. The installed package was checked separately on Node 22.0.0 with npm 10.5.1. Evidence, fixes and coverage limits are recorded in the validation report delivered separately with this task.

The full POSIX suite requires Python 3 available on `/usr/bin:/bin`, sh/bash/zsh, an allocatable PTY, and a non-root user for permission checks. Some Linux process-group checks use a subprocess supervisor and are explicitly inapplicable to macOS. Tests use isolated temporary homes and fake providers; they do not require API keys. To verify a separately installed package, run `npm run test:package -- /absolute/path/to/bin/howto`; this compiles and runs `tests/package-smoke.ts`, uses a local HTTP fixture, and only executes a harmless print command after confirmation.

Test CI runs only on Ubuntu 24.04 with Node 24.19.0. Pushes run unit tests; pull requests and manual runs execute both unit and integration tests. All runs also build the project and check lint and formatting. macOS runners, Node 22 jobs, and installed-package smoke jobs are excluded from CI; the local package smoke command remains available. Alpine, native arm64, WSL, and real terminal-emulator visuals remain unverified; a PTY or a configured job is not evidence for those platforms. A separate environment passed bounded live Gemini native and OpenAI-compatible protocol smoke checks; native structured-output OFF, the default model, and the full live CLI remain unverified.

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

### ChatGPT Fast, saved models and request timings

`howto --init` retrieves fresh account-specific choices and saves the selected
account/model in `~/.howto/config.json`. The selection survives CLI restarts.
Ordinary generation, `--print`, and every `use` turn directly use that configured
model, without a preliminary catalog GET. CLI/environment model overrides remain
per-invocation overrides; they do not overwrite the saved selection. Run
`howto --init` to persist a different selection or `howto --chatgpt-models` to
explicitly refresh/list choices. No disk or process-local catalog cache is needed.

Fast defaults on, requesting `service_tier: priority`; explicit false requests
`default`. Model and reasoning behavior are unchanged. The initialization picker
uses validated tier metadata to offer Fast (selected by default) when advertised;
missing catalog metadata does not prohibit a direct configured request. The server
is authoritative for actual account/model entitlement. Completed responses report
Fast, standard (including downgrade), or unconfirmed for absent/unknown metadata.
No partial generated command is executable before complete response validation.

Only explicit structured model/tier-unavailable errors trigger one catalog GET
using the same request credentials. That discovery is bounded to at most five
seconds, never retries inference, never changes model/tier, and never replaces the
original error if refresh fails. Generic network, authentication, quota, policy,
or unrelated unsupported errors do not trigger discovery. Explicitly disable Fast
with `--chatgpt-fast false` or select a different model when access is denied.

Fast may consume more plan usage/credits; Codex multipliers are not universal SIWC
promises. The official SIWC OAuth public `/v1/models` and `/v1/responses` routes are
retained, without private endpoints or API-key fallback. No speed gain is promised.

`--chatgpt-timings true` (default false) reports `catalog=not-requested`, time from
inference start to first SSE event, and completion time. A first event need not be
an output token. Diagnostics include no prompts, tokens, account IDs or response
content. Six independent successful CLI runs now send zero catalog GETs and six
inference POSTs; authentication refresh requests can still occur.

References: [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode),
[SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[SIWC UI/UX](https://developers.openai.com/siwc/ui-ux-guidelines).

Runtime controls (replace `YOUR_MODEL_SLUG` with a slug from your account):

```sh
howto --chatgpt-models
export HOWTO_AI_PROVIDER=chatgpt
export HOWTO_CHATGPT_MODEL='YOUR_MODEL_SLUG'
# Optional when multiple accounts exist:
export HOWTO_CHATGPT_ACCOUNT='YOUR_ACCOUNT_ID'

howto 'list files'                         # Fast on unless explicitly overridden
howto --chatgpt-fast true 'list files'
howto --chatgpt-fast false 'list files'
howto --chatgpt-timings true 'list files'   # timings default off
howto --chatgpt-timings false 'list files'
howto --print --chatgpt-fast=false 'list files'  # print only, no execution
howto --chatgpt-fast true use git 'show changed files'  # interactive usage lookup
HOWTO_CHATGPT_FAST=false HOWTO_CHATGPT_TIMINGS=true howto --print 'list files'
HOWTO_CHATGPT_FAST=false howto --chatgpt-fast=true --print 'list files' # CLI wins
```

Equivalent file keys are `aiProvider`, `chatgptAccount`, `chatgptModel`,
`chatgptFast`, `chatgptTimings`. Fast/timings accept JSON booleans or the strings
`"true"`/`"false"`. CLI/environment accept exactly lowercase `true` or `false`;
`1`, `0`, `yes`, uppercase and whitespace-padded values are invalid. Both
`--chatgpt-fast false` and `--chatgpt-fast=false` work; a bare flag is not a toggle
and requires a value. Timings obey the same precedence and syntax.
Account/model actions (`--chatgpt-models`, `--chatgpt-status`, login/logout) do not
accept Fast/timing flags. There is no runtime catalog cache, TTL, or clear control.
