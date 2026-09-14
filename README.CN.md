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
- **支持 OpenAI 和 Gemini** - 可通过 CLI 参数、环境变量或 `~/.howto/config.json` 配置 provider。
- **本地优先校验** - 本地校验 AI JSON 输出、占位符引用、`use <command>` 候选项以及明显危险命令。

## 安装

全局安装 CLI 包：

```bash
npm install -g @unscientificjszhai/howto
```

也可以从克隆的仓库中运行：

```bash
npm install
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

初始化和占位符输入支持按完整字符退格，包括 emoji 和组合字符；Alt/Meta 快捷键不会作为文本写入配置字段。
按键释放事件不会触发确认、取消、导航或再次删除；一次 Enter 的按下和释放不能跳过最终确认。

> [!NOTE]
> OpenAI API key 可以为空，以支持本地 OpenAI 兼容服务。Gemini 必须提供非空 API key。

询问一个命令：

```bash
howto 找到最近7天修改的文件 .
```

限制候选项必须使用某个工具：

```bash
howto use git 看看上周的提交
```

`use` 会在处理环境变量赋值及已支持的 `sudo`/`env` 选项后，精确核对首个实际工具。例如 `sudo -u root git status` 符合 `use git`，`sudo -u git id` 则不符合。`sudo`/`env` 的未知选项或缺少选项参数、动态执行前缀及复杂 shell 结构会被拒绝。这个约束只针对首段的工具，不限制后续命令段。

已声明的占位符可以出现在首工具之后，例如 `git log -n {{count}}`；工具名及其之前的前缀必须能在填写占位符前确定。模板分析不会修改最终命令原文。

不进入交互 UI，只打印候选命令：

```bash
howto --print 列出最大的文件 /var/log
```

## 使用

```text
howto [options] [use <command>] <question> [<argument>...]
howto --init
howto --version
```

示例：

```bash
howto 找到当前目录的package.json
howto use find 寻找特定文件名的文件 package.json
howto 解释这个命令 -- --force
howto --ai-provider openai --print 列出监听的端口
```

参数：

- `--init` - 启动交互式 provider 配置，并保存 `~/.howto/config.json`。
- `--version` - 单独使用，输出当前包版本号并成功退出；无需配置或 TTY，不调用 AI。
- `--print` - 打印已校验的命令候选项并退出，不执行命令。
- `--ai-provider <openai|gemini>` - 选择 AI provider。
- `--gemini-api-key <key>` - 提供 Gemini API key。
- `--gemini-model <model>` - 覆盖 Gemini 模型。
- `--openai-api-url <url>` - 使用自定义 OpenAI 兼容 base URL。
- `--openai-api-key <key>` - 提供 OpenAI API key。
- `--openai-model <model>` - 覆盖 OpenAI 模型。
- `--structured-output <true|false>` - 启用 SDK 级 schema 结构化输出；默认 `true`。

### 参数解析

`question` 是一个 shell 参数。包含空格时需要加引号：

```bash
howto "find recently changed files" /tmp
```

`question` 后面的内容会作为 `argument[]` 传给 AI。如果参数以 `--` 开头，请使用 `--` 结束 option 解析：

```bash
howto "explain this flag" -- --force
```

## 配置

配置按以下优先级解析：

1. CLI 参数
2. 环境变量
3. `~/.howto/config.json`
4. 内置默认值

配置路径使用绝对路径形式的 `HOME`。`HOME` 缺失或为空白时，howto 从系统用户信息查询主目录；非空相对 `HOME` 或系统查询失败会在创建文件前返回配置错误。

对每个配置项，优先级中第一个已配置的来源生效：

- `--ai-provider` / `HOWTO_AI_PROVIDER` / `aiProvider` - `openai` 或 `gemini`；无默认值。
- `--gemini-api-key` / `HOWTO_GEMINI_API_KEY` / `geminiApiKey` - Gemini API key；Gemini 必填。
- `--gemini-model` / `HOWTO_GEMINI_MODEL` / `geminiModel` - Gemini 模型；默认 `gemini-3.1-flash-lite`。
- `--openai-api-url` / `HOWTO_OPENAI_API_URL` / `openaiApiUrl` - OpenAI 兼容 base URL；默认 `https://api.openai.com/v1`。
- `--openai-api-key` / `HOWTO_OPENAI_API_KEY` / `openaiApiKey` - OpenAI API key；默认为空字符串以支持本地服务。
- `--openai-model` / `HOWTO_OPENAI_MODEL` / `openaiModel` - OpenAI 模型；默认 `gpt-5.4-mini`。
- `--structured-output` / `HOWTO_STRUCTURED_OUTPUT` / `structuredOutput` - 使用 provider schema 结构化输出；默认 `true`。

请求地址和 Gemini API 模式由 howto 显式设置。`OPENAI_BASE_URL`、`GOOGLE_GEMINI_BASE_URL`、`GOOGLE_VERTEX_BASE_URL` 及 Google SDK 的 Vertex/Enterprise 模式环境开关不会改写它们。Gemini 使用官方 `generativelanguage.googleapis.com` 的 `v1beta` API；自定义 OpenAI 地址请使用上述 HOWTO 配置项。

OpenAI 的 Authorization 使用 howto 配置的 key，空白 key 时不发送该请求头；`OPENAI_CUSTOM_HEADERS` 中的 Authorization 不会覆盖此选择。交互模式收到 OpenAI 限流或临时服务错误时直接报错，不自动重试，以保证取消后能及时退出；`--print` 保留 SDK 默认重试行为。

示例：

```bash
HOWTO_AI_PROVIDER=openai \
HOWTO_OPENAI_MODEL=gpt-5.4-mini \
howto --print "show current branch"
```

## 安全模型

`howto` 将 AI 输出视为不可信数据。在进入执行前，CLI 会检查：

- AI 响应是符合命令 schema 的有效 JSON；
- 响应包含一到三个候选项；
- 所有占位符使用 `{{name}}` 语法，并且声明与引用一致；同一候选中名称只声明一次，多处引用共用一次输入；
- `use <command>` 候选项在保守处理前缀后，明确以指定工具开头；
- 明显危险的命令需要输入 `EXECUTE` 才能继续执行；大小写不敏感。

危险命令检测当前覆盖递归破坏性 `rm`、磁盘和文件系统操作、大范围递归权限变更、下载脚本后直接交给 shell 执行、高影响包管理器操作以及服务变更等高风险模式。

本地分析会处理字面引号、绝对命令路径及已支持的 `sudo`/`env` 选项，并检查各命令段。遇到未知 wrapper 选项、动态执行前缀或超出解析范围的 shell 语法时，也会要求输入 `EXECUTE`，避免把无法判断的命令直接视为安全。

`env` 赋值中的数字开头、连字符或点名称也会正确识别，继续检查后面的实际命令。npm 全局安装/卸载的正式别名（如 `i`、`add`、`un`、`unlink`）使用同样的危险确认；不能确定的等价缩写也要求额外确认。
前导 `NAME+=value` 因 shell 方言差异要求额外确认，并被 `use` 校验拒绝；未受单引号或反斜杠保护的美元表达式保守按动态值判断。npm 的 `install-test`、`installTest`、`it` 复合安装及其缩写也纳入全局安装确认。

Homebrew 的 `rm/uninstal` 卸载别名，以及 yum/dnf 的 `update/erase` 升级或卸载入口，也使用相同的危险确认。各工具的动作分别识别，`apt update`、`brew update/up` 的索引更新不按系统软件升级处理。

一次交互调用中只要识别到 bracketed paste（包括自动初始化阶段），本次调用就永久改为输出最终命令供手动运行。最终确认页按 Enter 只输出命令，终端会显示说明；返回候选选择或调整终端大小都不会恢复执行权限。全程键盘输入仍使用原有的 Enter 或 `EXECUTE` 确认。

跨越终端视图隐藏阶段的粘贴会整块丢弃。这些规则针对已识别的 bracketed-paste 输入；终端协议无法认证任意粘贴按键或内容中的结束标记。执行限制针对 howto 自身启动候选命令的行为。

> [!WARNING]
> 未被标记为危险并不表示命令一定安全。本地检查会对已知高风险模式及无法分析的语法增加确认步骤，并不能证明命令安全。

## 开发

本项目使用 TypeScript、React、Ink、OpenAI SDK、Gemini GenAI SDK 和 Node 内置测试运行器构建。

```bash
npm install
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
- `tests/unit/` - CLI、配置、校验、执行、UI 和安全逻辑的单元测试。

## 故障排查

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
