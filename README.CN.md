# howto

_在终端中用 AI 快速找到可执行命令。_

![npm version](https://img.shields.io/npm/v/@unscientificjszhai/howto/latest)

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

不进入交互 UI，只打印候选命令：

```bash
howto --print 列出最大的文件 /var/log
```

## 使用

```text
howto [options] [use <command>] <question> [<argument>...]
howto --init
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
- `--print` - 打印已校验的命令候选项并退出，不执行命令。
- `--ai-provider <openai|gemini>` - 选择 AI provider。
- `--gemini-api-key <key>` - 提供 Gemini API key。
- `--gemini-model <model>` - 覆盖 Gemini 模型。
- `--openai-api-url <url>` - 使用自定义 OpenAI 兼容 base URL。
- `--openai-api-key <key>` - 提供 OpenAI API key。
- `--openai-model <model>` - 覆盖 OpenAI 模型。

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

对每个配置项，优先级中第一个已配置的来源生效：

- `--ai-provider` / `HOWTO_AI_PROVIDER` / `aiProvider` - `openai` 或 `gemini`；无默认值。
- `--gemini-api-key` / `HOWTO_GEMINI_API_KEY` / `geminiApiKey` - Gemini API key；Gemini 必填。
- `--gemini-model` / `HOWTO_GEMINI_MODEL` / `geminiModel` - Gemini 模型；默认 `gemini-3.1-flash-lite`。
- `--openai-api-url` / `HOWTO_OPENAI_API_URL` / `openaiApiUrl` - OpenAI 兼容 base URL；默认使用 OpenAI SDK 默认值。
- `--openai-api-key` / `HOWTO_OPENAI_API_KEY` / `openaiApiKey` - OpenAI API key；默认为空字符串以支持本地服务。
- `--openai-model` / `HOWTO_OPENAI_MODEL` / `openaiModel` - OpenAI 模型；默认 `gpt-5.4-mini`。

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
- 所有占位符使用 `{{name}}` 语法，并且声明与引用一致；
- `use <command>` 候选项在保守处理前缀后，明确以指定工具开头；
- 明显危险的命令需要输入 `EXECUTE` 才能继续执行。

危险命令检测当前覆盖递归破坏性 `rm`、磁盘和文件系统操作、大范围递归权限变更、下载脚本后直接交给 shell 执行、高影响包管理器操作以及服务变更等高风险模式。

> [!WARNING]
> 未被标记为危险并不表示命令一定安全。本地检查只会对已知高风险模式增加确认步骤，并不能证明命令安全。

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
