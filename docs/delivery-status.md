# 交付状态与上线边界

版本：`0.1.2`

基线日期：2026-07-29

目标：对照原始十个功能模块与生产级非功能要求，区分“已有代码”“端到端可用”和
“仍需目标环境验收”。

## 结论

当前仓库是可运行、可测试、可构建的工程候选版。Web 与 Windows Electron 的主流程
已有自动化验收，模型、密钥、聊天、用量、Skill/Workflow、插件、会话/快照/分支、
团队成员和桌面文件修改都存在真实业务链路，不是静态页面。

它仍不应被描述为“已获生产上线批准”。真实 Provider 矩阵、目标硬件性能、签名后的
三平台安装/更新、目标集群备份恢复和安全评审需要在组织自己的账号、证书和基础设施
中完成；部分扩展能力也仍有明确产品缺口。

本文使用以下状态：

| 状态     | 含义                                                             |
| -------- | ---------------------------------------------------------------- |
| 已实现   | 至少一个受支持入口端到端可用，并有自动化测试或本轮实测证据       |
| 部分实现 | 主链可用，但原始需求中的子能力、产品入口或故障恢复仍不完整       |
| 外部验收 | 代码和流水线已提供，但必须依赖真实账号、证书、操作系统或集群验证 |
| 未实现   | 没有受支持的业务入口；只有配置项、声明或底层预留不算实现         |

## 十个核心模块

### 1. 模型管理层 — 部分实现

已实现：

- 启动后台和手动触发的 OpenAI 兼容 `/models` 发现、缓存、厂商归类和能力推断；
- OpenAI、Anthropic、DeepSeek、Groq、Google、Ollama 与自定义 Provider 分类；
- code/chat/embedding/vision/function-calling 标签；
- 工作台与默认模型设置使用“服务商 → 该服务商模型”级联选择，切换服务商会恢复其
  上次选择且不会展示其他服务商模型；
- 2–4 模型并排比较、文本差异高亮和场景默认模型；
- 工作台默认按场景自动路由：普通消息与 `@chat` 使用聊天默认模型，独立 `@code`
  使用代码默认模型；用户手动选择服务商/模型后改为显式路由，并可一键回到自动模式。

边界：

- Anthropic/Google 原生认证、分页和非 OpenAI 请求格式没有专用适配器；当前可直接
  使用的是厂商提供的 OpenAI 兼容入口；
- 默认自动引导 OpenAI 兼容 Provider 与 Ollama，其他厂商需用户创建；
- 能力标签主要是启发式推断，不等于厂商的实时能力声明。

### 2. API Key 管理层 — 已实现（余额能力受 Provider 限制）

已实现：

- 同厂商多 Key 轮询、优先级/主备选择、启停和健康状态；
- 每小时健康检查、单 Key 检查、绿/黄/红/暂停状态；
- 日/月 USD 或 Token 限额、超额暂停、Key 池合计；
- 每 Key 独立 HTTP 代理；
- AES-256-GCM 信封加密，列表和日志不返回密文。

边界：

- 多数 Provider 没有标准实时余额接口，“剩余额度”来自本地限额与已记录用量；
- 邮件通知尚无 SMTP 分发器；成本阈值已有状态栏和桌面原生通知；
- 生产多租户仍应在部署层增加 Provider/代理出口白名单或 CNI FQDN 策略。

### 3. Token 与成本中心 — 已实现（报表规模有限）

已实现：

- 每次请求记录时间、模型、项目/用户、输入/输出/缓存 Token、成本、耗时和结果；
- 日/周/月、模型、项目和用户聚合；
- ECharts Token 趋势、模型占比和每日成本；
- 每日阈值状态栏告警、Toast 与 Desktop 原生通知；
- CSV、JSON、PDF 导出。

边界：

- 当前导出查询上限为 200 条，超大报表需要分页/后台任务；
- PDF 使用基础字体并替换不支持的 Unicode，中文正式报表需嵌入授权字体；
- 成本来自本地价格表估算，不是 Provider 最终账单。

### 4. 智能上下文管理 — 部分实现

已实现：

- 上下文 Token 预算、来源占比和 70% 可配阈值；
- 使用设置的低成本模型压缩旧消息，失败时确定性摘要回退，并记录摘要用量；
- 项目记忆表、Repository 和聊天加载链路；
- Desktop 支持 `@file`、`@folder`、`@web`，并复用工作区边界；
- Web 支持经过协议、DNS、私网地址、重定向、类型和大小限制的 `@web`；浏览器端
  `@file`/`@folder` 会返回明确的 Desktop-only 错误。

边界：

- 尚无根据当前编辑历史自动选择文件/目录的语义路由；
- 项目/长期记忆没有完整 CRUD 页面；
- 网页抓取不是浏览器自动化，不执行 JavaScript，也不绕过登录或反爬策略。

### 5. Skill 与 Workflow — 已实现（高级恢复能力缺失）

已实现：

- `plugins/builtin-skills` 提供 `@bug-fix`、`@architect`、`@refactor`、
  `@security-audit`、`@browser-research`、`@computer-operator`、`@doc-gen`、
  `@test-gen`、`@db-helper`、`@deploy`、`@explain` 共 11 个双语 Skill；另附独立的
  `@code-review` 示例 Skill 插件；
- 严格 `skill.json`、Prompt 变量、确定性预分析器和插件命令映射；
- Skill 注册/启停、Server 与 Desktop 调用；
- Workflow DAG 校验、持久化、创建、排序、保存、运行、逐步骤结果和删除。
- 基础 system Prompt 按身份、安全、实际工具、上下文、任务场景和输出约定分层生成，
  与 Skill Prompt 幂等合并，并区分 Desktop/Web 能力。

边界：

- 没有 Workflow 运行历史、失败 Step 恢复、整条 Workflow 取消和逐 Step 成本关联；
- Web 设计器以线性流程为主，底层 Schema/Registry 才支持一般 DAG；
- Server 编排器以 Prompt 执行为主，插件静态 executor 当前由 Desktop resolver 调用。

### 6. 插件系统 — 部分实现

已实现：

- `manifest.json` 校验，UI/Hook/Provider/Tool 四类贡献声明；
- 本地目录与无凭据 HTTPS Git 安装、staging/备份、完整性摘要、授权、启停、可恢复
  卸载、开发态热加载；
- 独立 Plugin Host、Node 权限模型、网络/文件/环境变量/通知能力代理；
- Server 的 `request:before`/`request:after`、注册/登录/退出会话 Hook；
- Desktop 用户批准文件写入前后的 `file:before-save`/`file:after-save`；
- Hook 只接收严格校验的脱敏元数据，单插件错误被隔离。

边界：

- UI contribution 尚未渲染到侧边栏、工具栏或右键菜单；
- Provider contribution 尚未接入模型发现和聊天 Provider 注册表；
- “更新”通过重新安装同一来源完成，没有版本源轮询和升级确认流程；
- 子进程与权限代理用于降低风险，不是可安全运行任意恶意 Node.js 代码的绝对沙箱；
- 文件 Hook 是尽力而为的观察事件，不是持久事务事件总线。

### 7. 会话与工作区 — 已实现（逐行审批与项目分组缺失）

已实现：

- 会话创建、搜索、置顶、归档、删除；
- 从历史消息创建分支，并显示真实直接子分支数量；
- 每 50 条消息自动快照、手动快照、快照历史、二次确认恢复；
- Desktop 工作区绑定、目录/文件读取、路径穿越与符号链接防护；
- AI `workspace_read_file`、`workspace_list_files`、`workspace_find_files`、
  `workspace_search_text` 只读工具；
- AI `workspace_propose_write` 工具生成 Diff，`workspace_run_command` 通过独立卡片审批；
- `computer_system_info` 返回不含用户名、主机名和环境变量的系统概况；
  `computer_list_processes` 经审批后只返回进程名、PID、CPU/内存元数据；
- 按对话隔离的 `browser_open`、`browser_navigate`、`browser_extract`、
  `browser_screenshot` 只读浏览工具；网络导航默认关闭，逐次审批完整 URL 后才启用
  best-effort public-only DNS 预检，并阻止写请求、下载、弹窗和权限请求；
- 用户整体接受/拒绝后执行哈希冲突检查、原子写入、写后校验和恢复映射；
- 工具结果按调用持久化并显示参数、状态、耗时、结果、截断或错误；模型可在只读工具
  返回后继续生成，最多四轮；
- 工作区绑定使用版本化随机 ID，切换工作区后旧文件提案和待执行命令均 fail closed；
- 切换/删除会话、流式消息和快照请求有竞态保护。

边界：

- 当前只能整体接受或拒绝文件，传入逐行选择会明确失败且不会写盘；
- 左侧按时间分组，不是按项目树分组；没有项目管理页面；
- Web 出于浏览器权限边界不能直接读写本机工作区。
- 电脑工具当前不提供键盘、鼠标、窗口枚举或 GUI 点击；浏览器工具不支持表单输入、
  上传、下载或登录态复用。
- Chromium 会独立解析域名；浏览器 DNS 公网地址预检不是固定出口代理或严格 SSRF
  隔离，不能宣称完全阻止 DNS rebinding。

### 跨模块：MCP 与统一工具执行 — Desktop 已实现

已实现：

- Desktop MCP 管理页支持新增、启停、刷新和移除 stdio/Streamable HTTP Server；
- MCP initialize、工具分页发现/变化刷新、稳定命名空间、`tools/call`、取消、并发、
  超时、消息/输出上限和生命周期关闭；
- MCP 工具与内置工具合并进模型函数清单，并复用审批、审计、脱敏、持久化和工具结果卡；
- 所有第三方 MCP 工具调用均逐次等待用户批准；Server 的只读、非破坏、非 open-world
  注解只在审批卡中提示，不会触发自动执行；
- stdio 使用 `shell:false` 和最小环境；远程 HTTP 默认要求 HTTPS，localhost 可用 HTTP；
- 整份 MCP 配置（含可选 stdio 环境变量和 HTTP Header）通过桌面端安全存储加密；
  Renderer 状态摘要隐藏 Header、环境变量、URL 查询和内嵌凭据，只返回凭据存在状态；
- 审批身份绑定 Server、Endpoint、原工具名、Schema/注解和本次配置版本；配置变更、
  刷新或应用重启后旧审批失效；
- 当前 MCP 协议集成仅支持 Tools，不导入 Resources 或 Prompts。

边界：

- MCP 仅在 Desktop 可用，Web 不会在用户设备上连接或执行 Server；
- stdio Server 仍以当前 OS 用户权限运行，Streamable HTTP 的实际网络与数据边界由
  Server 决定；MCP 不是可安全运行任意不可信代码/服务的沙箱；
- MCP 工具注解由 Server 提供，不是独立安全证明。批准每次调用前应核对真实 Server、
  工具名、参数、网络目标和副作用；
- 自定义 Header/环境变量虽加密保存，仍不要把密钥写入 URL、stdio 参数、日志或截图；
- 工具结果卡会脱敏和截断，但不能证明第三方结果真实、无提示注入或无数据外传。

### 8. 用户与权限 — 部分实现

已实现：

- Desktop 本地 SQLite 单机 Owner；
- Web 自建 Server 的注册/登录/退出；
- Owner/Admin/Member/Viewer 路由权限；
- 成员列表、创建、改角色、启停、删除和管理页面；
- 停用/删除成员会使旧令牌失效；
- 密钥、设置、会话、成员、插件 Hook 等敏感操作的审计记录。

边界：

- 没有邮件邀请、SSO/SCIM 或密码重置流程；
- 协作模式是单写 Fastify + SQLite，不含多人实时光标、文件冲突合并或水平多写；
- 审计覆盖仍应在目标组织的合规清单中复核。

### 9. 性能与可靠性 — 部分实现

已实现：

- 默认并发 5 的可配置队列、硬上限、实时排队位置和取消后位置前移；
- 指数退避、抖动、最多三次、请求/响应体超时和 Abort；
- SSE 分块/CRLF/大小限制、客户端断开清理和 ProxyAgent 关闭；
- 标准 `tool_calls` 快照与流式增量均可解析；对实测 Provider 的 error-only、
  XML-like 单工具信封仅在函数声明和参数 Schema 严格匹配时恢复，污染、重复字段、
  多工具、尾随文本或超限输入全部 fail closed；
- 相同幂等请求的完成结果缓存；
- Ollama Provider 和 Node/Python/目录/插件宿主等启动自检；
- 分级日志、7 天轮转、健康端点、Prometheus 指标和基础告警。

边界：

- 没有 Provider checkpoint/resume token，不能恢复已中断生成；
- `ollamaFallback` 仍是设置项，Provider 故障时不会自动改投 Ollama；
- 重试继续使用已选择的 Key；不支持所有厂商的安全幂等，极端情况下可能重复计费；
- 完成后记账允许并发请求短暂超过配额；
- 首屏、UI/API p95 和内存目标仍需目标硬件报告。

### 10. 国际化与体验 — 部分实现

已实现：

- 中文/英文 Locale 基础、系统语言跟随和手动切换；
- 12 个主题标识、深浅/高对比等样式；
- Ctrl+Enter、Ctrl+B、Ctrl+Shift+N 等主流程快捷键；
- Toast、错误边界、空/加载/错误状态和桌面原生通知；
- 七步首次使用教程及可重复打开入口，包含桌面工具、审批和 MCP 安全边界；
- Thinking 流式展开、完成后保留耗时并默认折叠，支持始终展开或隐藏；
- 工具策略、命令超时、输出上限与运行中卡片行为设置。

边界：

- 多数业务页文案仍以中文为主，不是完整双语；
- 快捷键没有可编辑、持久化和冲突检查；
- 部分设置页展示的组合键尚无行为；
- 长任务完成通知尚未覆盖所有后台任务。

## 非功能门禁

| 维度                  | 当前状态 | 证据与边界                                                                    |
| --------------------- | -------- | ----------------------------------------------------------------------------- |
| TypeScript/格式       | 已实现   | 17 个 workspace 包 `typecheck`，ESLint 零 warning，Prettier check             |
| 核心单测覆盖率 ≥80%   | 已实现   | 全仓行覆盖率 87.63%；核心包逐包执行独立阈值，Server 也固定为 80/70/80/80      |
| E2E 主流程            | 已实现   | Web 登录/聊天/Key/快照恢复与 Windows Electron 冷启动/安全边界                 |
| 错误处理              | 部分实现 | Error Boundary、Fastify/IPC 统一错误和 Toast；不声称每个 Promise 都手写 catch |
| 日志与轮转            | 已实现   | Server/Desktop debug/info/warn/error，敏感字段脱敏，保留最近 7 天             |
| 性能 SLA              | 外部验收 | 有 SSE 基准和运行时采样，尚无目标硬件 20 次冷启动/p95/长会话报告              |
| Key 与敏感数据安全    | 已实现   | AES-256-GCM、safeStorage 主密钥、日志脱敏、密钥扫描；仍需外部渗透测试         |
| 三平台安装包/自动更新 | 外部验收 | Windows NSIS 与冷启动已通过；签名、公证、macOS/Linux 和更新回滚仍需目标环境   |
| CI/CD                 | 已实现   | CI、Release、安全扫描、SBOM、校验和、OIDC 签名和 provenance 配置              |
| Web/集群部署          | 部分实现 | Docker/Compose/Kustomize；NetworkPolicy 为 opt-in overlay，需按集群适配       |

## 本轮自动化证据

最终发布候选必须保留命令输出或 CI Artifact；仅存在测试文件不算通过记录。

| 检查                           | 本地结果/说明                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装与 Peer 依赖               | `pnpm install`、`pnpm peers check` 通过                                                                                                                                                     |
| 生产依赖审计                   | `pnpm audit --prod`：0 个已知漏洞                                                                                                                                                           |
| 格式、Lint、工作区/密钥扫描    | Prettier、ESLint、工作区校验和密钥扫描通过；仓库未发现真实 API Key                                                                                                                          |
| TypeScript / 生产构建          | 17/17 workspace 包类型检查及构建通过                                                                                                                                                        |
| Vitest                         | 83 个测试文件、595 项测试全部通过                                                                                                                                                           |
| 全仓 Coverage                  | Statements 86.09%、Branches 77.09%、Functions 88.44%、Lines 87.63%                                                                                                                          |
| Server 独立 Coverage           | 82 项测试；Statements 81.77%、Branches 70.67%、Functions 83.87%、Lines 84.56%                                                                                                               |
| App UI 独立 Coverage           | 164 项测试；Statements 92.52%、Branches 80.86%、Functions 90.86%、Lines 93.22%                                                                                                              |
| Desktop 独立 Coverage          | 82 项测试；Statements 82.18%、Branches 73.03%、Functions 87.36%、Lines 83.36%                                                                                                               |
| 独立 Coverage 门禁             | Contracts、Config、Security、Observability、AI Runtime、Core、Database、Plugin、Server、Desktop 等全部通过                                                                                  |
| Web Playwright                 | 6/6：登录/流式聊天、凭据边界、快照、Key、成员管理及服务商级联/Thinking/工具卡/窄窗口                                                                                                        |
| Desktop Playwright             | 1/1：生产入口、单窗口、preload 隔离和安全边界                                                                                                                                               |
| Windows 打包启动               | Electron 41 原生 ABI 查询校验及解包应用冷启动/自检通过                                                                                                                                      |
| Windows NSIS                   | 135,057,542 bytes；SHA-256 `B97AA125285EE19357C5998FD2BB5AE04D854A503EEAA31413FC4FEBA24C520F`                                                                                               |
| 本地安装包签名                 | `NotSigned`；正式发布流水线无签名凭据时会安全失败                                                                                                                                           |
| OpenAPI/文档链接/安全/性能契约 | 根 Vitest 项目覆盖                                                                                                                                                                          |
| 真实 Provider 完整流程         | UI 添加兼容服务商与加密 Key，目标 Provider 下发现 7 个可见模型；`Qwen3.6-35B-A3B` 先生成文件 Diff，确认后精确写入，再请求命令并等待单独批准后返回 Node 版本；Thinking 完成后保留 3s/2s 摘要 |
| 真实文件证据                   | `e-agent-tool-smoke-20260729.txt` 内容精确匹配；SHA-256 `2D2A029F8BC4F6298AE98FD8EC6106F7B6CA35D0572555BC68D5BC765DBF19A9`                                                                  |

## 仍阻止“生产完成”声明的事项

1. 在专用测试账号完成 Provider 矩阵：模型发现、流式、工具调用、429/5xx、超时、
   取消、代理、配额、Key 切换和账单对账。
2. 在目标 Windows/macOS/Linux 完成签名安装、卸载、权限、自动更新、回滚和 Release
   feed 验收；当前本机不能替代 macOS 公证或 Linux 发行版矩阵。
3. 在目标硬件完成至少 20 次冷/热启动、首屏、UI/API p95、长会话和常驻内存报告。
4. 在目标 Compose/Kubernetes 环境注入正式域名、镜像 digest、Secret、StorageClass、
   备份任务、告警接收人和容量；演练 SQLite 完整性检查与恢复。
5. 由产品负责人决定是否接受剩余功能边界：语义路由/记忆 UI、逐行文件审批、
   UI/Provider 插件贡献、生成断点恢复、自动 Ollama 故障转移、完整 i18n、可定制
   快捷键、邮件通知与 Workflow 恢复。
6. 完成供应链/权限/SSRF/跨用户/插件边界的外部安全评审和主密钥轮换演练。

## 明确不作出的承诺

- 不承诺当前版本已经满足原始需求的每一个子项或已获生产审批；
- 不承诺原生支持每个厂商私有协议；核心传输是 OpenAI 兼容接口；
- 不承诺本地估算成本与 Provider 最终账单完全一致；
- 不承诺插件宿主能安全运行任意不可信本机代码；
- 不承诺 Provider 不支持时可以恢复中断的生成；
- 不承诺没有外部模型且没有本地模型时能生成新的离线回答；
- 不承诺模型输出本身正确、安全或第三方服务持续可用。

## 发布验收记录模板

```text
Release/tag:
Commit:
Environment:
Installer signatures:
SBOM/checksum/provenance:
Quality commands:
Coverage report:
Web E2E:
Desktop E2E (Windows/macOS/Linux):
Provider matrix:
Security review:
Performance report:
Backup restore:
Approver/date:
Accepted limitations:
```
