# E Agent

面向生产目标构建的桌面端 + Web 端双模 AI 编程助手工程预览版。E Agent 将模型发现、多
API Key 调度、流式对话、成本可观测、项目上下文、Skill 工作流、MCP 工具和隔离插件
运行时放在一个 TypeScript monorepo 中，并为本地单机与自建协作服务提供同一套
契约。

> 当前版本：`0.1.2`。这是可运行的工程基线，不代表原始十模块需求已全部完成或
> 已通过生产上线审批。逐项实现、缺口、已验证路径和仍需外部凭据或平台签名的项目
> 见 [交付状态](docs/delivery-status.md)。不要将测试供应商
> 密钥写入代码、`.env.example`、日志或截图。

[English](#english) · [架构](docs/architecture.md) ·
[安全](SECURITY.md) · [部署](docs/deployment.md) ·
[运维](docs/operations.md) · [插件开发](docs/plugins.md) ·
[Skill 开发](docs/skills.md)

## 能力概览

- OpenAI 兼容接口与 Ollama 模型发现、能力推断、按服务商筛选，以及不同场景的默认模型。
- 多 Key 轮询/主备、健康状态、独立代理、Token/成本配额和暂停策略。
- SSE 流式对话、指数退避、并发队列、用量记录和成本聚合。
- 桌面 Electron 安全桥接与 Web 协作服务，共用 React UI 和类型化契约。
- 会话、快照历史/恢复、分支和工作区上下文；内置文件读取、目录浏览、文件名查找、
  文本搜索、文件修改提案与受控命令工具，文件仍遵循“AI 提案 → Diff → 用户确认 →
  原子写入”。
- 桌面端提供最小化系统信息、需审批的进程列表，以及按对话隔离的只读浏览器工具；
  浏览器网络操作逐次审批，采用 best-effort public-only DNS 预检，支持提取文本或
  受限 HTML 和截图，不支持点击、输入、上传或下载。该预检不是严格 SSRF 网络隔离。
- 桌面端 MCP 管理器支持 stdio 与 Streamable HTTP，自动发现已启用 Server 的工具；
  每次第三方 MCP 工具调用都必须人工批准，并复用审计、超时、输出上限和结果卡片。
  当前协议集成仅覆盖 MCP Tools，不导入 MCP Resources 或 Prompts。
- 流式 Thinking 独立展示，完成后保留为“已思考 13s”折叠卡；工具参数、结果、耗时、
  截断和错误以状态卡展示。
- 内置 Skill 包提供 11 个双语 Skill，另附独立的 `@code-review` 示例 Skill 插件；
  支持可保存/运行的 DAG Workflow，以及 UI/Hook/Provider/Tool 四类插件贡献声明。
- 分层系统提示词按身份、安全、实际工具清单、上下文、任务场景和输出约定组合，并与
  Skill Prompt 幂等合并；网页、文件和工具结果始终作为不可信数据处理。
- 插件独立宿主进程、权限白名单、安装完整性校验和开发态热加载。
- AES-256-GCM Key 加密、RBAC、敏感字段脱敏、审计/日志/指标基础设施。
- Vitest、Playwright、OpenAPI 契约、安全门禁、SBOM、三平台签名发布流水线。

## 技术架构

```text
apps/
  desktop       Electron 主进程、preload 与自动更新
  web           浏览器入口
  server        Fastify 协作 API、SSE、认证与健康检查
  plugin-host   独立插件宿主进程
packages/
  ai-runtime    模型发现、SSE、重试与 Provider 客户端
  app-ui        React 页面、组件、Zustand Store 与传输层
  contracts     Zod/API 共享契约
  core          队列、上下文、配额、会话与领域服务
  database      Drizzle + SQLite schema/repository/migration
  mcp-runtime   MCP stdio/Streamable HTTP、工具发现与调用生命周期
  plugin-*      插件 SDK 与生命周期运行时
  security      加密、口令、Token 与日志脱敏
  skills        Skill 注册、模板与 Workflow 编排
```

详细的信任边界、调用链与持久化设计见
[docs/architecture.md](docs/architecture.md)。

## 环境要求

- Node.js 22.22.0 或更高版本
- pnpm 11.9.0（仓库通过 `packageManager` 固定版本）
- Git 2.40+（仅安装 Git 插件时需要）
- 桌面构建需目标系统的原生工具；macOS 签名/公证只能在 macOS Runner 完成
- Web 容器部署可选 Docker 26+ 与 Compose v2

建议 Windows 使用 PowerShell 7，macOS/Linux 使用当前维护版本的 Bash。

## 快速开始

```sh
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install
```

复制环境模板：

```sh
# macOS / Linux
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

为本地环境生成彼此不同的随机值，并写入 `.env`：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('base64:'+require('node:crypto').randomBytes(32).toString('base64'))"
```

第一项用于 `E_AGENT_SESSION_SECRET`，第二项用于
`E_AGENT_MASTER_KEY`。生产 Server 首次注册 Owner 时还必须从密钥管理系统注入至少
32 字符的 `E_AGENT_BOOTSTRAP_TOKEN`；客户端只通过
`X-E-Agent-Bootstrap-Token` Header 提交。已有用户后该 Token 不再授权注册。
所有生产密钥都不能写入镜像。

Compose 与 Kubernetes 清单允许已完成初始化的现有数据库移除该一次性 Secret；全新生产
数据库仍必须配置它。未初始化时，公开的 `GET /api/v1/auth/status` 会返回
`bootstrapTokenRequired: true`，Web 初始化页据此显示必填密码框；缺失配置不会被当成
无需令牌。

初始化数据库并启动：

```sh
pnpm db:generate
pnpm db:migrate
pnpm dev
```

也可以分别运行：

```sh
pnpm dev:server
pnpm dev:web
pnpm dev:desktop
```

默认地址：

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:4318`
- 存活检查：`http://127.0.0.1:4318/health/live`
- 就绪检查：`http://127.0.0.1:4318/health/ready`

首次启动后在「模型与密钥」页面添加 Provider 和 Key。密钥只提交给本地服务，
落库前使用 AES-256-GCM 加密，列表接口只返回掩码。

## 五分钟使用指南

1. 首次进入会自动打开「快速上手」。也可以随时从左侧导航或「设置 → 使用教程」
   重新打开。
2. 在「模型与密钥」添加服务商名称、类型、Base URL 和 API Key，然后执行模型发现。
   工作台顶部先选择服务商，第二个下拉框只展示该服务商可用的模型，不会混入其他厂商。
3. 在「设置 → 默认模型」分别配置代码、聊天和摘要场景。每个场景同样先选服务商，
   再从该服务商的模型中选择。
4. 在工作台绑定项目文件夹。模型可读取文件、列目录、按名称查找文件和搜索文本；
   这些只读工具会把结果显示为可折叠卡片。桌面端还可读取不含用户名/主机名的系统
   概况；进程列表只返回名称、PID、CPU/内存统计并需要单独批准。
5. 让模型修改文件时，E Agent 先生成 Diff，只有点击接受才会原子写入。让模型执行命令
   时必须在命令卡中人工确认；命令使用参数数组运行，不经过系统 Shell，并受可执行程序、
   子命令、超时和输出大小限制。
6. 桌面浏览器网络导航默认 fail closed；逐次核对并批准完整 URL 后，才可显式启用
   best-effort public-only 导航、内容提取或截图。会话不持久化 Cookie，并通过 DNS
   预检拒绝私网/本机地址，同时阻止写请求、下载、弹窗和权限请求。Chromium 会独立解析
   域名，因此该预检不是固定出口代理或严格 SSRF 隔离；它也不会登录、点击或提交表单。
7. 在「设置 → MCP Server」添加受信任的本地 stdio Server 或远程 Streamable HTTP
   Server。远程地址默认要求 HTTPS；工具会按 Server 命名空间暴露，并在统一工具卡中
   显示状态与结果。可选的 stdio 环境变量和 HTTP Header 随 MCP 配置一起进入桌面端
   加密存储，Renderer 只会看到“已配置凭据”的布尔状态；所有 MCP 工具仍逐次等待批准。
   Windows 下 `npm`、`npx`、`pnpm` 和 `yarn` 会解析到真实 Node CLI，始终保持
   `shell:false`，不会通过 `cmd.exe` 执行命令垫片。
8. Thinking 在生成时自动展开，完成后默认折叠并保留耗时。可在「设置 → 对话与工具」
   改为始终展开或隐藏，并启用/禁用工具、调整命令超时、输出上限和运行中卡片行为。

> 本地文件、电脑、浏览器和 MCP 工具仅在桌面端可用。命令及 stdio MCP 进程仍以当前
> 操作系统用户权限运行；MCP Server、其工具声明和返回内容都不等于可信沙箱。无论工具
> 策略或 Server 的 `readOnlyHint` 如何声明，每次第三方 MCP 调用都必须由用户逐次批准
> 并核对真实 Server、工具名、参数与目标。自定义环境变量/Header 会加密保存，但不要把
> 密钥放入 URL、命令参数、日志或截图。Web 端不会代替用户设备连接 MCP，也不会直接
> 访问浏览器所在电脑的文件系统。

## 连接 OpenAI 兼容供应商

在 UI 中创建 `custom` 或对应厂商 Provider，填写以 `/v1` 结尾的 Base URL，再
添加 Key 和默认模型。云端与自定义 Provider 必须使用 HTTPS；仅 `ollama` 类型可
通过 HTTP 访问 `localhost`、`127.0.0.0/8` 或 `::1` 回环地址。也可仅为本地开发设置：

```dotenv
E_AGENT_PROVIDER_BASE_URL=https://provider.example/v1
E_AGENT_DEFAULT_MODEL=replace-with-model-id
```

真实 Key 不使用 `VITE_` 环境变量，也不应写入任意前端构建变量。`VITE_` 值会被
打包到浏览器代码中。

用专用测试 Key 验证模型发现、SSE 和工具调用时，只在当前进程注入以下三个变量，
然后运行 `pnpm smoke:provider`。脚本只输出计数、耗时和 Token 用量，不输出响应正文
或 Key；测试后应立即清除环境变量。

```sh
E_AGENT_PROVIDER_SMOKE_BASE_URL=https://provider.example/v1 \
E_AGENT_PROVIDER_SMOKE_API_KEY='<temporary-test-key>' \
E_AGENT_PROVIDER_SMOKE_MODEL='<model-id>' \
pnpm smoke:provider
```

## 配置

完整清单以 [`.env.example`](.env.example) 和
`packages/config/src/index.ts` 为准。关键项：

| 变量                         | 默认值                  | 说明                                          |
| ---------------------------- | ----------------------- | --------------------------------------------- |
| `NODE_ENV`                   | `development`           | 生产部署必须设为 `production`                 |
| `E_AGENT_HOST`               | `127.0.0.1`             | 容器中使用 `0.0.0.0`                          |
| `E_AGENT_PORT`               | `4318`                  | API 监听端口                                  |
| `E_AGENT_DATABASE_URL`       | `./data/e-agent.db`     | SQLite 文件或 `:memory:`                      |
| `E_AGENT_SESSION_SECRET`     | 仅开发默认值            | 至少 32 字符；生产必须轮换                    |
| `E_AGENT_MASTER_KEY`         | 无                      | `base64:`/`hex:` 后跟 32 字节，或至少 32 字符 |
| `E_AGENT_BOOTSTRAP_TOKEN`    | 空                      | 生产首个 Owner 的一次性凭据，至少 32 字符     |
| `E_AGENT_ALLOWED_ORIGINS`    | `http://localhost:5173` | 逗号分隔的精确 Origin                         |
| `E_AGENT_AUTH_DISABLED`      | `false`                 | 仅隔离的本地开发可启用                        |
| `E_AGENT_TRUST_PROXY`        | `false`                 | 仅在受控反向代理后启用                        |
| `E_AGENT_MAX_BODY_BYTES`     | `2000000`               | 请求体上限                                    |
| `E_AGENT_REQUEST_TIMEOUT_MS` | `120000`                | 上游请求超时                                  |
| `E_AGENT_LOG_LEVEL`          | `info`                  | `debug/info/warn/error/silent`                |
| `E_AGENT_OTEL_EXPORTER_URL`  | 空                      | 可选 OpenTelemetry Collector                  |
| `VITE_E_AGENT_API_URL`       | `http://127.0.0.1:4318` | Web 端 API 地址，不得包含密钥                 |

## 开发与质量门禁

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm test:e2e:web
pnpm test:e2e:desktop
pnpm build
```

跨模块契约、安全和性能测试位于 `tests/`。Playwright 失败时会保留 trace、截图
和视频。CI 会额外执行密钥扫描、依赖审计、CodeQL、Trivy、SBOM 生成与工作区
校验。

桌面 E2E 需要先构建：

```sh
pnpm --filter @e-agent/desktop build
pnpm exec playwright install
pnpm test:e2e:desktop
```

## 构建与发布

生产构建：

```sh
node scripts/build/build-production.mjs
node scripts/build/build-production.mjs --package-desktop
```

单独生成桌面安装包：

```sh
pnpm validate:installer
pnpm package:desktop
```

该入口会先为当前 Electron 版本强制重建 SQLite 原生模块，并在 Electron 进程中创建
内存数据库执行查询；ABI 校验失败时不会生成安装包。无论成功或失败，脚本结束时都会
恢复当前 Node ABI 并再次执行内存查询。请勿绕过该入口直接调用 `electron-builder`。

Windows 版使用非一键安装向导。继续安装前必须阅读并勾选接受中英文风险告知，可选择
当前用户/所有用户范围并修改安装目录。卸载前会再次明确确认；普通卸载只移除程序文件
和快捷方式，默认保留本地会话、设置、插件及加密凭据，避免意外丢失。

发布工作流 `.github/workflows/release.yml` 在 `vX.Y.Z` Tag 或手动触发时：

1. 执行格式、Lint、类型、测试、覆盖率和生产构建门禁。
2. 在 Windows、macOS、Linux 原生 Runner 生成 `.exe`、`.dmg`、`.AppImage`。
3. 要求 Windows/macOS 代码签名，macOS 可通过 Apple 凭据公证。
4. 构建并推送 Web/Server 多架构容器及 SLSA provenance。
5. 生成 CycloneDX SBOM、发布清单、SHA-256 和 Sigstore OIDC 签名。
6. 创建 GitHub Release 并保留 90 天发布包。

所需仓库 Secrets 见 [部署文档](docs/deployment.md#发布签名与公证)。没有原生签名
凭据时工作流会安全失败，不会发布未签名安装包。

## Docker Compose

```sh
export E_AGENT_SESSION_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
export E_AGENT_MASTER_KEY="base64:$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
export E_AGENT_BOOTSTRAP_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))")"
docker compose up --build -d
node scripts/smoke/smoke-web.mjs \
  --api-url http://127.0.0.1:4318 \
  --web-url http://127.0.0.1:8080
```

数据默认写入命名卷 `e-agent-data`。升级前必须备份 SQLite 数据库并验证恢复。

## API 与扩展

- HTTP/SSE 契约：[`infra/openapi/e-agent.v1.json`](infra/openapi/e-agent.v1.json)
- 插件规范与权限：[`docs/plugins.md`](docs/plugins.md)
- Skill 与 Workflow：[`docs/skills.md`](docs/skills.md)
- 内置技能插件：`plugins/code-review`、`plugins/builtin-skills`

插件安装不代表授权或启用。每次权限声明变化后都必须重新确认；网络、文件、
环境变量和通知能力由宿主代理，未声明即拒绝。

## 安全报告

请不要在公开 Issue 中提交漏洞、Key、数据库或日志。报告流程、支持版本、响应
时限和取证要求见 [SECURITY.md](SECURITY.md)。

## 许可证

[Apache License 2.0](LICENSE)

---

## English

E Agent is a dual-mode desktop and Web AI programming assistant. It combines
model discovery, multi-key routing, streaming chat, cost observability, project
context, declarative Skills, MCP tools, and an isolated plugin host in a TypeScript
monorepo. The local desktop client and the self-hosted collaboration server
share the same contracts and React UI.

Version `0.1.2` is a runnable engineering baseline, not a claim that every
original module is complete or approved for production. See the
[delivery status](docs/delivery-status.md) for verified paths, functional gaps,
preview capabilities, and production prerequisites. Never place provider
credentials in source, example environment files, logs, screenshots, or
client-side `VITE_` variables.

### Capability overview

- Provider-scoped model discovery, multi-key routing, streaming chat, usage
  accounting, cost views, conversations, snapshots, branches, and workspace
  context.
- Desktop workspace tools for reading, listing, finding, and searching files;
  file changes remain reviewable Diff proposals, while command execution
  requires approval and uses bounded argument arrays without a system shell.
  - Minimal non-identifying system information, approval-gated process metadata,
    and a conversation-isolated read-only browser. Browser network actions require
    per-call approval and use best-effort public-only DNS preflight; this is not a
    strict SSRF boundary. It does not click, type, upload, download, or submit forms.
- Desktop MCP management for stdio and Streamable HTTP servers. Every external
  MCP tool call requires explicit per-call approval and then uses the common
  audit, timeout, output-limit, and result-card pipeline. The current protocol
  integration supports MCP Tools only, not MCP Resources or Prompts.
- Eleven bilingual Skills in the built-in Skill bundle plus the separate
  `@code-review` example Skill plugin, with persisted DAG Workflows.
- A layered system prompt combines identity, safety, the tools actually exposed,
  context, task strategy, and output rules, then merges Skill prompts
  idempotently. Files, pages, and tool results remain untrusted input.

### Requirements

- Node.js 22.22.0+
- pnpm 11.9.0
- Git 2.40+ for Git-based plugin installation
- Docker 26+ and Compose v2 for the optional Web deployment
- Native target operating systems and signing identities for desktop releases

### Start locally

```sh
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Generate separate session and encryption keys:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log('base64:'+require('node:crypto').randomBytes(32).toString('base64'))"
```

Place them in `E_AGENT_SESSION_SECRET` and `E_AGENT_MASTER_KEY`. A fresh
production Server also requires a separate, random `E_AGENT_BOOTSTRAP_TOKEN`
for the first Owner registration, submitted only in the
`X-E-Agent-Bootstrap-Token` header. Once any user exists, that token no longer
authorizes registration. Production secrets must be injected by a secret manager.
The Compose and Kubernetes manifests intentionally let an already initialized
database remove this one-time secret. A fresh production database must still set it:
`GET /api/v1/auth/status` returns `bootstrapTokenRequired: true`, and the Web setup
page then requires the non-persistent token field.

The Web UI runs at `http://127.0.0.1:5173`; the API runs at
`http://127.0.0.1:4318`. Add a provider and encrypted API key from the model/key
settings page.

### Five-minute workflow

1. Add a provider, Base URL, and API key, then run model discovery. The workspace
   model menu only shows models from the selected provider.
2. Keep automatic routing for the configured `@code` and `@chat` defaults, or
   select an explicit provider/model for the current conversation.
3. Bind a desktop workspace. Read, list, filename-find, and text-search results
   appear as tool cards. File changes remain proposals until you accept the Diff.
4. Command execution always requires a separate approval. It uses argument
   arrays without a system shell and enforces allowlists, timeouts, and output
   limits, but it still runs with the current OS user privileges and is not a
   complete operating-system sandbox.
5. Desktop can return non-identifying system information and, after approval,
   process names/PIDs/CPU/memory statistics. Browser navigation fails closed by
   default and requires per-call approval of the complete URL before enabling the
   best-effort public-only policy. DNS preflight rejects private targets, while
   writes, downloads, popups, and permissions are blocked. Because Chromium
   resolves hosts independently, this is not a pinned-egress or strict SSRF boundary.
6. Add a trusted local stdio or remote Streamable HTTP server under
   **Settings → MCP Server**. Remote URLs require HTTPS by default. MCP tools
   are namespaced and rendered through the common tool-card pipeline. Optional
   stdio environment variables and HTTP headers are stored with the encrypted
   desktop MCP configuration; the renderer receives only a credentials-present
   flag. Every MCP tool call still waits for explicit approval.
7. Streaming reasoning stays visible after completion as a collapsed
   “Reasoned for Ns” card. Its display mode and tool limits are configurable,
   and the first-run tutorial can be reopened from Settings.

Local files, computer inspection, the isolated browser, and MCP are
desktop-only. Commands and stdio MCP servers run with the current OS user's
privileges. MCP servers, annotations, and results are not a trusted sandbox;
every external MCP call requires per-call approval regardless of the selected
tool policy or a server-supplied `readOnlyHint`. Verify the actual server, tool,
arguments, and target before approving. Custom environment variables and
headers are encrypted at rest, but never embed secrets in URLs, process
arguments, logs, or screenshots. The Web client neither connects MCP on the
user's device nor gains local filesystem access.

### Quality commands

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm test:e2e:web
pnpm test:e2e:desktop
pnpm build
```

CI also runs repository secret scanning, dependency audits, CodeQL, Trivy,
contract/security/performance suites, CycloneDX SBOM generation, native package
smoke checks, checksums, and provenance.

For a minimal real-provider check, inject
`E_AGENT_PROVIDER_SMOKE_BASE_URL`, `E_AGENT_PROVIDER_SMOKE_API_KEY`, and
`E_AGENT_PROVIDER_SMOKE_MODEL` into the current process and run
`pnpm smoke:provider`. The command checks model discovery, SSE, and one function
call without printing credentials or response content.

### Build and deploy

```sh
node scripts/build/build-production.mjs
pnpm validate:installer
pnpm package:desktop
docker compose up --build -d
```

The desktop packaging entry force-rebuilds `better-sqlite3` for the pinned
Electron ABI and executes an in-memory query before packaging. Its `finally`
path restores the current Node ABI and validates another in-memory query. Do not
bypass it with a direct `electron-builder` invocation.

The Windows build uses an assisted installer. Users must accept the bilingual
risk notice, may choose the installation scope and directory, and must explicitly
confirm uninstall. A normal uninstall removes application files and shortcuts
while keeping local conversations, settings, plugins, and encrypted credentials.

The release workflow builds signed Windows, macOS, and Linux installers plus
multi-architecture Web/Server container images. Read
[deployment](docs/deployment.md), [operations](docs/operations.md), and
[security](docs/security.md) before exposing a server to a network.

### Documentation

- [Architecture](docs/architecture.md)
- [Security design](docs/security.md)
- [Plugin development](docs/plugins.md)
- [Skill and Workflow development](docs/skills.md)
- [Deployment](docs/deployment.md)
- [Operations](docs/operations.md)
- [Performance budgets](docs/performance.md)
- [Testing](docs/testing.md)

Licensed under [Apache-2.0](LICENSE).
