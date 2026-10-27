# howto

_在终端中用 AI 快速找到可执行命令。_

[![npm version](https://img.shields.io/npm/v/@unscientificjszhai/howto/latest)](https://www.npmjs.com/package/@unscientificjszhai/howto)
[![GitHub Actions Test Status](https://github.com/UnscientificJsZhai/HowTo/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/UnscientificJsZhai/HowTo/actions)
[![code style: prettier](https://img.shields.io/badge/code_style-prettier-ff69b4.svg)](https://github.com/prettier/prettier)
[![License](https://img.shields.io/github/license/UnscientificJsZhai/HowTo)](LICENSE)

[English](README.md) | 简体中文

[功能](#功能) • [安装](#安装) • [使用](#使用) • [配置](#配置) • [开发](#开发) • [故障排查](#故障排查)

`howto` 是一个 TypeScript CLI工具，使用自然语言向它提问，它会给你候选命令供你选择。它不会直接运行 AI 输出：你需要在终端中选择候选命令，填写占位符（如有），检查最终命令，然后确认执行。

> [!IMPORTANT]
> `howto` 是命令生成助手，不是沙箱。执行前请检查每一条命令，尤其是会修改文件、安装包、变更权限或使用提权操作的命令。

## 功能

- **自然语言生成命令** - 描述任务后获得简洁的 shell 命令候选项。
- **指定工具模式** - 使用 `howto use <command>` 要求候选项围绕某个 CLI 工具生成。
- **交互式确认流程** - 选择候选项、填写占位符，并在执行前确认最终命令。
- **非交互打印模式** - 使用 `--print` 输出候选命令，不进入 TTY 交互，也不执行命令。
- **支持 ChatGPT、OpenAI 和 Gemini** - 可使用 ChatGPT 登录与符合条件的账户额度，也可继续使用 API key 和 OpenAI 兼容服务。
- **本地优先校验** - 本地校验 AI JSON 输出、占位符引用、`use <command>` 候选项以及明显危险命令。

## 安装

需要 **Node.js 22 或更高版本**。npm 包通过 `engines.node` 声明此要求，与现有运行依赖的最低版本保持一致。

仅支持 **macOS 和 Linux**。不支持原生 Windows，包括 CMD、PowerShell，以及使用 Windows 版 Node.js 的 Git Bash／MSYS2。WSL 必须在 Linux 环境内安装并运行 Node.js；目前尚未完成 WSL 专项验收。npm 安装和 CLI 启动均检查操作系统。

交互执行只允许 `sh`、`bash`、`zsh`。`SHELL` 可以是这三个裸名称之一，或文件名为这三个名称之一的绝对路径（例如 `/bin/zsh`、`/opt/homebrew/bin/bash`）；不接受相对路径或附加参数。`SHELL` 缺失或仅含空白时使用 `/bin/sh`，包括系统提供的 `/bin/sh` 符号链接。其他 shell 会在初始化或请求 AI 之前被拒绝，不会静默切换解释器；实际执行前会再次检查。可用 `env SHELL=/bin/bash howto "列出文件"` 显式选择执行 shell。

`--print`、`--init` 和 `--version` 不执行候选命令，因此只检查操作系统，不限制 `SHELL`。不支持的操作系统或执行 shell 返回退出码 `2`。此限制针对 howto 启动的外层解释器，不限制候选命令自行启动的程序，也不构成沙箱。

全局安装 CLI 包：

```bash
npm install -g @unscientificjszhai/howto
```

也可以从克隆的仓库中运行：

```bash
npm ci
npm run build
npm link
```

之后即可使用 `howto` 命令。

## 快速开始

初始化 AI provider 配置：

```bash
howto --init
```

初始化程序会把用户级配置写入 `~/.howto/config.json`。

选择 **Continue with ChatGPT** 后，在系统浏览器完成登录和额度授权，再选择账号及该账号实时可用的模型。使用官方开源 Sign in with ChatGPT 流程，本机回调仅监听 `127.0.0.1`，无需 client secret 或安装 Codex。重新初始化会保留其他 provider 的 API key 和既有 `structuredOutput` 设置。

也可单独管理账号：

```bash
howto --chatgpt-login
howto --chatgpt-status
howto --chatgpt-models --chatgpt-account <账号ID>
howto --chatgpt-login --chatgpt-account <账号ID>
howto --chatgpt-logout --chatgpt-account <账号ID>
```

不带账号 ID 的登录会新增注册；指定 ID 则复用该注册重新登录。单独登录不改变 provider、默认账号或模型，使用 `howto --init` 保存选择。普通生成和 `--print` 不会自动打开登录页。模型来自该账号目录中的可见 slug，不自动换模型，也不回退到 API key 计费。

凭证独立保存在 `~/.howto/chatgpt/`，目录仅本人可访问、文件仅本人可读写，刷新和注销跨进程互斥；`config.json` 只保存账号与模型选择。刷新响应丢失时需要重新登录，避免重放可能已经消费的旋转 token。注销会保留注册映射，并在远程撤销未确认时明确提示。额度及授权在 [ChatGPT 设置](https://chatgpt.com/settings/usage) 中管理；可用性取决于账号资格和当前模型目录，参见[官方开源流程](https://developers.openai.com/siwc/token-sharing-open-source)。

初始化和占位符输入支持按完整字符退格，包括 emoji 和组合字符；Alt/Meta 快捷键不会作为文本写入配置字段。
按键释放事件不会触发确认、取消、导航或再次删除；一次 Enter 的按下和释放不能跳过最终确认。
终端将键盘文本与 Enter 合并送达时，输入仍按顺序处理；当前步骤结束后，同批剩余按键不能跳过下一页确认。粘贴中的换行保留为数据。

> [!NOTE]
> OpenAI API key 可以为空，以支持本地 OpenAI 兼容服务。Gemini 必须提供非空 API key。

询问一个命令：

```bash
howto 找到当前目录中最近7天修改的文件
```

限制候选项必须使用某个工具：

```bash
howto use git 看看上周的提交
```

`use` 会在处理环境变量赋值及已支持的 `sudo`/`env` 选项后，精确核对首个实际工具。例如 `sudo -u root git status` 符合 `use git`，`sudo -u git id` 则不符合。`sudo`/`env` 的未知选项或缺少选项参数、动态执行前缀及复杂 shell 结构会被拒绝。这个约束只针对首段的工具，不限制后续命令段。

已声明的占位符可以出现在首工具之后，例如 `git log -n {{count}}`；工具名及其之前的前缀必须能在填写占位符前确定。模板分析不会修改最终命令原文。

不进入交互 UI，只打印候选命令：

```bash
howto --print 列出 /var/log 中最大的文件
```

### 通过 SSH 登录 ChatGPT

在有浏览器的本地电脑上建立 SSH 连接和回环端口转发：

```bash
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:1455:127.0.0.1:1455 user@server
```

进入远程 shell 后启动登录：

```bash
howto --chatgpt-login --no-browser --callback-port 1455
```

在本地浏览器打开输出的授权链接，保持 SSH 连接与 HowTo 运行，直到登录完成。将 `user@server` 替换为实际 SSH 目标。浏览器会回调本地电脑的 `127.0.0.1`，隧道再将回调转发给服务器上的 HowTo，无需向公网开放回调端口。服务器仍需能通过 HTTPS 访问 OpenAI 认证与 API 服务。

若希望在同一次交互中完成登录并保存 provider、账号和模型选择，可改用 `howto --init --no-browser --callback-port 1455`，再选择 **Continue with ChatGPT**。初始化要求 TTY，独立登录命令不要求 TTY。

两个选项均可单独使用，仅允许搭配 `--chatgpt-login` 或 `--init`，只影响本次调用。`--no-browser` 完全跳过浏览器启动器，已有账号重新登录时也会输出授权链接。`--callback-port` 接受 `1`–`65535` 的十进制整数；省略时随机分配可用端口，并输出对应端口的转发指引。选项不会写入配置，也不影响 API key provider。

本地或远程端口无法绑定时，应选择另一个可用端口，同时修改隧道两端与 `--callback-port`；HowTo 不会静默替换明确指定的端口。已通过 SSH 连接时，可在另一个本地终端运行输出的 `ssh -N ...` 指令，再打开授权链接。登录最多等待 10 分钟，Ctrl+C 可取消并释放回调监听。登录后的普通请求和令牌刷新无需浏览器。本流程仍需在本地电脑的浏览器中授权，不使用设备码，也不接受粘贴回调地址。

## 使用

```text
howto [options] [use <command>] <question...>
howto --init [--no-browser] [--callback-port <port>]
howto --version
howto --chatgpt-login [--chatgpt-account <id>] [--no-browser] [--callback-port <port>]
```

示例：

```bash
howto 找到当前目录的package.json
howto use find 在 /tmp 中查找 report.txt
howto 解释这个选项 -- --force
howto --ai-provider openai --print 列出监听的端口
```

参数：

- `--init` - 启动交互式 provider 配置，并保存 `~/.howto/config.json`。
- `--version` - 单独使用，输出当前包版本号并成功退出；无需配置或 TTY，不调用 AI。
- `--print` - 打印已校验的命令候选项并退出，不执行命令。
- `--ai-provider <openai|gemini|chatgpt>` - 选择 AI provider。
- `--chatgpt-account <id>` / `--chatgpt-model <slug>` - 选择已保存的 ChatGPT 注册和当前可用模型。
- `--no-browser` - 跳过 ChatGPT 浏览器启动器并输出授权链接，仅用于 `--chatgpt-login` 或 `--init`。
- `--callback-port <port>` - 指定 ChatGPT 回环回调端口（`1`–`65535`，默认随机分配可用端口），仅用于 `--chatgpt-login` 或 `--init`。
- `--gemini-api-key <key>` - 提供 Gemini API key。
- `--gemini-model <model>` - 覆盖 Gemini 模型。
- `--openai-api-url <url>` - 使用自定义 OpenAI 兼容 base URL。
- `--openai-api-key <key>` - 提供 OpenAI API key。
- `--openai-model <model>` - 覆盖 OpenAI 模型。
- `--structured-output <true|false>` - 启用 SDK 级 schema 结构化输出；默认 `true`。

### 参数解析

全部问题片段以一个 ASCII 空格连接为 `question`。首个位置参数是 `use` 时，其后一个参数作为工具名，其余片段组成问题。全局选项在 `--` 之前仍可穿插使用，未知长选项报错；`--` 之后全部作为位置文本。

| 输入                                        | 最终 question                |
| ------------------------------------------- | ---------------------------- |
| `howto list files changed today`            | `list files changed today`   |
| `howto "list files" /tmp`                   | `list files /tmp`            |
| `howto use find find report.txt under /tmp` | `find report.txt under /tmp` |
| `howto list files --print`                  | `list files`，同时启用打印   |
| `howto explain -- --force`                  | `explain --force`            |
| `howto find files "/tmp/my files"`          | `find files /tmp/my files`   |
| `howto "" "   "`                            | 用法错误                     |

片段内部的原始空格、换行及其他内容均保留。缺失或全空白问题在配置加载和 AI 请求之前返回退出码 `2` 与 Usage；仅用 `trim()` 判断是否全为空白，不修剪实际问题，不重建引号，也不额外传递分段信息。

模型根据完整问题识别路径、文件名、数量和选项。用途明确的值填入候选命令，缺失或含糊的必要值生成占位符，沿用现有填写和确认流程。

原有带引号的问题仍可使用；原来的“问题 + 附加参数”写法会整体进入 `question`，不再保留参数分组语义。拼接后无法恢复 shell 参数边界，含空格路径由模型结合问题语义理解，建议明确描述路径的用途。

免引号适用于普通提问文本。变量、通配符、重定向等特殊语法仍先由 shell 处理，需要传递字面内容时继续引用或转义。管理动作和重复选项规则保持不变，无需配置迁移。

## 配置

配置按以下优先级解析：

1. CLI 参数
2. 环境变量
3. `~/.howto/config.json`
4. 内置默认值

配置路径使用绝对路径形式的 `HOME`。`HOME` 缺失或为空白时，howto 从系统用户信息查询主目录；非空相对 `HOME` 或系统查询失败会在创建文件前返回配置错误。

对每个配置项，优先级中第一个已配置的来源生效：

- `--ai-provider` / `HOWTO_AI_PROVIDER` / `aiProvider` - `openai`、`gemini` 或 `chatgpt`；无默认值。
- `--chatgpt-account` / `HOWTO_CHATGPT_ACCOUNT` / `chatgptAccount` - 本机 ChatGPT 注册 ID；保存了多个账号时必须明确指定。
- `--chatgpt-model` / `HOWTO_CHATGPT_MODEL` / `chatgptModel` - `--chatgpt-models` 返回的可见模型 slug；没有固定默认值。
- `--gemini-api-key` / `HOWTO_GEMINI_API_KEY` / `geminiApiKey` - Gemini API key；Gemini 必填。
- `--gemini-model` / `HOWTO_GEMINI_MODEL` / `geminiModel` - Gemini 模型；默认 `gemini-3.5-flash-lite`。
- `--openai-api-url` / `HOWTO_OPENAI_API_URL` / `openaiApiUrl` - OpenAI 兼容 base URL；默认 `https://api.openai.com/v1`。
- `--openai-api-key` / `HOWTO_OPENAI_API_KEY` / `openaiApiKey` - OpenAI API key；默认为空字符串以支持本地服务。
- `--openai-model` / `HOWTO_OPENAI_MODEL` / `openaiModel` - OpenAI 模型；默认 `gpt-6-luna`。
- `--structured-output` / `HOWTO_STRUCTURED_OUTPUT` / `structuredOutput` - 使用 provider schema 结构化输出；默认 `true`。

请求地址和 Gemini API 模式由 howto 显式设置。`OPENAI_BASE_URL`、`GOOGLE_GEMINI_BASE_URL`、`GOOGLE_VERTEX_BASE_URL` 及 Google SDK 的 Vertex/Enterprise 模式环境开关不会改写它们。Gemini 使用官方 `generativelanguage.googleapis.com` 的 `v1beta` API；自定义 OpenAI 地址请使用上述 HOWTO 配置项。

OpenAI 的 Authorization 使用 howto 配置的 key，空白 key 时不发送该请求头；`OPENAI_CUSTOM_HEADERS` 中的 Authorization 不会覆盖此选择。交互模式收到 OpenAI 限流或临时服务错误时直接报错，不自动重试，以保证取消后能及时退出；`--print` 保留 SDK 默认重试行为。

示例：

```bash
HOWTO_AI_PROVIDER=openai \
HOWTO_OPENAI_MODEL=gpt-6-luna \
howto --print "show current branch"
```

## 安全模型

`howto` 将 AI 输出视为不可信数据。在进入执行前，CLI 会检查：

- AI 响应是符合命令 schema 的有效 JSON；
- 响应包含一到三个候选项；
- 所有占位符使用 `{{name}}` 语法，并且声明与引用一致；同一候选中名称只声明一次，多处引用共用一次输入；
- `use <command>` 候选项在保守处理前缀后，明确以指定工具开头；
- 静态检查命中危险、无法判定或 AI 标记危险的命令，需要输入 `EXECUTE` 才能继续执行；大小写不敏感。

AI 在生成候选的同一次请求中逐个返回必填的 `dangerous` 布尔值和 `dangerReason` 字符串。标记危险时必须提供非空白的简短原因；未标记时原因必须为 `""`。缺失字段、类型错误或不合法组合会拒绝整份响应并返回退出码 `2`，旧格式响应不自动兼容；两种 Provider 和输出模式使用相同规则。

提示词要求 AI 结合完整命令评估数据损失、重要数据覆盖、破坏性历史改写、系统或权限变更、服务中断、敏感信息外发和不可信代码执行等风险，补充静态规则可能未覆盖的操作。普通查询、创建文件和常规构建不因具有副作用而一律标记。

最终确认始终检查占位符替换后的命令，并保留原候选的 AI 标记；AI false 不能降低静态危险或无法判定的确认要求。仅 AI 标记时显示 `AI: <原因>`，两者均命中时保留静态原因并追加 AI 原因。填写占位符不会新增 AI 请求或发送填写值。`--print` 也校验这些字段，但仍只输出命令。

危险命令检测当前覆盖递归破坏性 `rm`、磁盘和文件系统操作、大范围递归权限变更、下载脚本后直接交给 shell 执行、高影响包管理器操作以及服务变更等高风险模式。

本地分析会处理字面引号、绝对命令路径及已支持的 `sudo`/`env` 选项，并检查各命令段。遇到未知 wrapper 选项、动态执行前缀或超出解析范围的 shell 语法时，也会要求输入 `EXECUTE`，避免把无法判断的命令直接视为安全。

`ash`、`hush` 命令体和 BusyBox applet 分派均保守要求额外确认，包括 `busybox ls` 等尚未展开分析的调用。这不改变外层执行 shell 仅支持 sh/bash/zsh 的限制。

数字文件描述符中的续行因 shell 方言差异要求额外确认，并被 `use` 校验拒绝。风险分析会识别 `./../important` 和 `///dev/disk2` 等含冗余 `.` 或斜杠的高风险路径，不折叠 `..`，也不修改实际执行命令。

`env` 赋值中的数字开头、连字符或点名称也会正确识别，继续检查后面的实际命令。npm 全局安装/卸载的正式别名（如 `i`、`add`、`un`、`unlink`）使用同样的危险确认；不能确定的等价缩写也要求额外确认。
前导 `NAME+=value` 因 shell 方言差异要求额外确认，并被 `use` 校验拒绝；未受单引号或反斜杠保护的美元表达式保守按动态值判断。npm 的 `install-test`、`installTest`、`it` 复合安装及其缩写也纳入全局安装确认。

Homebrew 的 `rm/uninstal` 卸载别名，以及 yum/dnf 的 `update/erase` 升级或卸载入口，也使用相同的危险确认。各工具的动作分别识别，`apt update`、`brew update/up` 的索引更新不按系统软件升级处理。

Linux 还覆盖 apk、pacman、zypper 的系统包变更及 OpenRC 的服务和运行级别变更，例如 `apk upgrade`、`pacman -Syu`、`zypper dup`、`rc-service sshd stop`、`rc-update del sshd`。常见查询及 apk/zypper 索引更新保留普通确认；未支持的选项、动态参数和额外服务命令保守要求 `EXECUTE`。查询动作也检查参数，例如会写入文件的 `zypper repos --export …` 仍需额外确认。

交互粘贴不会关闭命令执行或 `use` 用法查询。API key、占位符和查询参数编辑字段接收完整粘贴，CR/LF 作为数据保留，不触发提交；每个字段提交后，同批剩余按键和粘贴都会丢弃。候选选择、查询审批及最终确认页忽略粘贴，危险确认短语 `EXECUTE` 必须键盘输入，最终执行仍需独立确认。

包含禁用控制字符（包括 Tab），或跨越字段、页面、隐藏阶段的粘贴整块丢弃，终端会显示原因。每块粘贴最多 256 KiB；未闭合粘贴连续 5 秒无新数据或总时长达到 30 秒时，howto 会取消本次交互、恢复终端并退出 1，不执行命令。

这些规则针对完整有效的 bracketed-paste 输入。终端协议无法认证内容中的伪结束标记及其后延迟字节，也不能严格区分未使用该协议的粘贴与连续键入；页面隔离不构成任意伪造输入均不能触发执行的保证。

> [!WARNING]
> 静态检查未命中且 AI 未标记危险，也不表示命令一定安全。两者用于增加确认要求，不构成完整安全证明或 AI 判断准确率保证。

## 开发

本项目使用 TypeScript、React、Ink、OpenAI SDK、Gemini GenAI SDK 和 Node 内置测试运行器构建。

开发和运行完整测试使用 **Node.js 22.x（22.22.1 及以上）或 24.x（24.3.0 及以上）**。这些版本满足开发依赖的要求。

```bash
npm ci
npm run build
npm test
npm run lint
npm run format:check
```

常用路径：

- `src/index.tsx` - CLI 编排和执行流程。
- `src/cli.ts` - 参数解析。
- `src/config.ts` - 配置合并和 provider 校验。
- `src/prompt.ts` - prompt 和 AI 输出契约。
- `src/validation/` - AI 响应和命令工具校验。
- `src/safety/` - 危险命令规则。
- `src/ui/` - 基于 Ink 的终端 UI。
- `tests/unit/` - 参数解析、配置合并、校验、Prompt、UI 纯逻辑与静态渲染，以及使用依赖替身的 provider 测试。
- `tests/integration/` - 文件系统与凭据存储、真实 SDK 序列化、Ink 组件交互及完整 UI 流程、CLI 进程、本地回环 HTTP Provider 与 PTY 终端会话测试。
- `tests/helpers/` - 两类测试共享的输入流、请求数据及渲染辅助工具。

`npm test` 运行单元与集成测试；仅运行其中一类可使用 `npm run test:unit` 或 `npm run test:integration`。

### Linux 验证范围

1.0.2 本地验证使用 Cloud 容器中的 Debian 13.6 x86_64、Node 22.22.1 / 24.19.0，以及 dash（`/bin/sh`）、bash 5.2.37、zsh 5.9 和真实内核 PTY。两个 Node 版本均通过 719 项测试且无跳过，其中 42 项为 PTY 用例；稳定性轮次和新增边界证据见验收报告。已安装发行包另以 Node 22.0.0 和 npm 10.5.1 验证。证据、修复及覆盖边界记录在随本次任务单独交付的验收报告中。

完整 POSIX 测试需要 `/usr/bin:/bin` 中可找到的 Python 3、sh/bash/zsh、可分配的 PTY，以及用于权限检查的非 root 用户。部分 Linux 进程组测试使用监督子进程，明确不适用于 macOS。测试使用隔离临时主目录和假 provider，不需要 API Key。单独验证已安装包可运行 `npm run test:package -- /absolute/path/to/bin/howto`；该命令将 `tests/package-smoke.ts` 编译后运行，使用本地 HTTP fixture，确认后只执行无害打印命令。CI 随候选包上传编译后的验收入口，最低 Node 版本的包验收无需安装开发依赖。

CI 配置已增加 Ubuntu 24.04 的 Node 22.22.1 / 24.19.0、macOS 14 回归，以及 Node 22.0.0 / 24.19.0 已安装包检查。本地任务未运行这些远端 job。Alpine、原生 arm64、WSL、真实终端模拟器视觉体验仍未验收；PTY 或已配置的 job 不能替代这些平台的运行证据。独立新版环境已完成有限的 Gemini 原生及 OpenAI 兼容协议实网烟测；原生结构化 OFF、默认模型和完整 CLI 实网仍未验证。

## 故障排查

### Linux 终端与输出失败

Linux 交互交接需要可访问 `/proc/self/fd/0`，用于同步检查尚在内核队列中的粘贴；读取失败时会拒绝执行。macOS 的同类内核队列边界尚待专项验证。

交互模式和 `--init` 要求 stdin、stdout 都是 TTY；任一流被重定向时请使用 `--print`。stdout 管道提前关闭时现在返回 1 和固定错误提示，不能将截断输出当作成功交付。PTY 测试找不到 Python 时可检查 `PATH=/usr/bin:/bin python3 --version`；CI 将缺失前置工具和 Linux 测试跳过视作失败。

HowTo 以 `-c` 调用选中的 shell，不使用登录 shell；这不表示环境被隔离，启动文件和继承的变量仍可能影响命令。配置文件以 0600 权限原子写入；现有目录权限和目录符号链接保持原契约。特别在宽松 umask 下，应确保配置目录及父目录不允许其他用户改写。

### AI provider 未配置

运行：

```bash
howto --init
```

`--print` 会有意跳过初始化流程。请先配置 provider，或传入对应 CLI 参数/环境变量。

### 非交互终端错误

默认模式需要交互式 TTY 来选择和确认命令。在脚本或 CI 中请使用 `--print`：

```bash
howto --print "show disk usage"
```

### Gemini key 必填

Gemini 不能在没有 API key 的情况下运行。请设置 `HOWTO_GEMINI_API_KEY`，传入 `--gemini-api-key`，或重新运行 `howto --init`。
