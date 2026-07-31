# 安全设计与威胁模型

本文描述 E Agent 的安全目标和工程控制。漏洞报告流程见根目录
[`SECURITY.md`](../SECURITY.md)。

## 1. 资产

最高敏感资产：

- Provider API Key、代理认证信息、SMTP 口令和主密钥；
- 用户口令哈希、访问 Token、会话与项目源代码；
- 模型 Prompt/响应、工具调用参数、长期记忆和审计日志；
- 插件审批、自动更新元数据、代码签名身份与 CI 发布 Token；
- SQLite 数据库、备份、崩溃转储和支持包。

可用性资产包括请求队列、Provider 配额、数据库写能力和自动更新渠道。

## 2. 攻击者与边界

考虑：

- 能控制 Prompt、网页内容、仓库文件或模型输出的攻击者；
- 能提交恶意插件/Git 仓库或诱导用户批准过宽权限的攻击者；
- 未认证网络客户端、低权限团队成员和被盗访问 Token；
- 恶意/失陷模型供应商、代理、依赖包或发布 Runner；
- 能读取用户普通文件但不能读取操作系统密钥库的本机进程。

不假设 Renderer、模型输出、插件代码、远程网页或 HTTP 响应可信。操作系统管理员
或已完全控制主进程的攻击者超出应用沙箱能单独抵御的范围，但静态密钥与备份仍
应由外部密钥系统保护。

## 3. 密钥与加密

### 存储

- Key 使用 AES-256-GCM，每次加密独立随机 12 字节 IV 和 16 字节认证标签。
- 密文信封包含算法/版本，以用途字符串作为 AAD，防止跨字段替换。
- `E_AGENT_MASTER_KEY` 可使用 `base64:`/`hex:` 编码的 32 字节值；普通部署
  口令至少 32 字符并经 SHA-256 派生。
- 数据库列表只返回 `maskedValue`；密文和主密钥都不能进入 DTO。
- 生产主密钥来自 OS Keychain、KMS、容器 Secret 或 Secret Manager，不写镜像、
  Git、Compose 文件或命令历史。

### 传输

- 远程 Web 只通过 TLS 1.2+，HTTP 自动跳转 HTTPS，并启用 HSTS。
- Provider Base URL 强制使用 HTTPS；仅本地 Ollama 可通过 HTTP 访问
  `localhost`、`127.0.0.0/8` 或 `::1` 回环地址，其他内网地址同样拒绝。
- 禁止将 Key 放入 URL query。Provider 请求使用 Header，错误日志先脱敏。

### 轮换

Session Secret 轮换会使现有 Token 失效，应在维护窗口进行。主密钥必须使用
双密钥迁移：保留旧密钥读取，批量重新加密，验证后切换写入，再安全销毁旧密钥。
迁移前做加密备份和恢复演练。

## 4. 认证、授权与租户隔离

- 口令使用内存/CPU 成本受控的现代哈希，并恒定时间验证；
- 登录失败按来源和账户限速，错误不区分“用户不存在/口令错误”；
- 访问 Token 有签名、发行方、过期、subject、role 和唯一 ID；
- logout 将当前 Token 的唯一 ID 持久化到 SQLite 撤销表；后续认证与进程重启后都
  会拒绝该 Token，其他并行登录会话不受影响，过期撤销记录在启动和撤销时清理；
- Owner/Admin/Member/Viewer 权限在服务端领域边界执行，UI 隐藏按钮不是授权；
- 所有资源查询带用户/团队作用域，避免只按资源 ID 查询；
- 删除会话、修改 Key/Provider/角色/插件权限进入审计日志；
- `E_AGENT_AUTH_DISABLED` 只用于隔离本地开发；生产环境设置为 `true` 时，配置
  解析与 Server 认证初始化都会 fail-closed，进程不会监听端口。

审计记录包括 actor、动作、资源类型/ID、时间、request ID、结果和脱敏元数据。
不记录 Key、Prompt 全文、模型响应全文或口令。

## 5. Electron

- `contextIsolation: true`、`nodeIntegration: false`、启用 Chromium sandbox；
- preload 只用 `contextBridge` 暴露窄接口，不暴露 `ipcRenderer`、`fs` 或任意调用；
- IPC 主进程校验 sender、参数 schema、工作区根和授权；
- 禁止 `shell.openExternal` 打开非 `https:` 地址，URL 需二次确认；
- 拒绝任意导航、新窗口、权限请求和不受信任 WebView；
- CSP 禁止 `unsafe-eval`；生产只加载打包资源或固定可信 Origin；
- 自动更新只接受签名发布与固定渠道，不忽略 TLS/签名错误；
- Release Workflow 将所有第三方 Action 固定到完整提交，Windows 校验
  Authenticode，macOS 校验 code signature、公证票据和 Gatekeeper；
- 文件修改先写临时 Diff 并由用户逐项接受，防路径穿越和符号链接逃逸。

## 6. 插件

安装控制：

- Git 源只允许不含用户名/口令的 HTTPS URL；
- staging 中限制总文件数/字节数，拒绝符号链接、特殊文件和越界入口；
- Manifest 严格 schema，未知字段拒绝；
- 树摘要绑定审批，更新或权限变化后重新批准；
- 同版本替换原子执行，失败恢复备份，卸载先移入 `.trash`。

运行控制：

- 每个插件独立宿主进程，崩溃不拖垮主进程；
- 模块加载器限制内建模块和越界导入；
- network/fileSystem/env/notifications 由主进程 Broker 白名单代理；
- 网络主机匹配在 DNS 解析和重定向后复核，阻断 loopback/link-local/metadata
  地址，除非 Manifest 与用户明确批准；
- 文件路径 `realpath` 后必须在批准根目录，写入使用原子替换；
- 调用有超时、消息大小和并发上限，日志字段也经过脱敏。

独立 Node 进程主要隔离故障和收口权限，不是强对抗沙箱，也不能阻止插件向父进程
发送操作系统信号。企业部署只应安装可信插件，并维护允许列表、镜像插件源、固定
提交和代码审查。

## 7. Prompt、上下文与工具

- `@file`/`@folder` 只解析当前授权工作区，默认尊重敏感文件忽略规则；
- `@web` 对响应大小、Content-Type、重定向次数和目标网段设限；
- 外部内容标记为“不可信上下文”，不能覆盖系统/开发者规则；
- 模型提出工具调用只是请求，参数经 schema 和权限校验后才执行；
- 只读工具在执行前后都校验不可伪造的工作区绑定 ID，并跳过 `.git`、`node_modules`、
  构建产物等目录；敏感文件拒绝读取，输出继续执行脱敏和大小限制；
- 文件修改只生成带内容哈希的提案，切换工作区后旧提案 fail closed，Renderer 不能
  绕过 Diff 审批直接写盘；
- 本机命令始终人工审批。审批接口不接收命令参数，Runner 使用 `shell:false`、参数数组、
  受控 `cwd`、环境白名单、可执行程序与子命令规则，并拒绝解释器内联代码、包安装/
  发布和破坏性 Git 操作；
- 命令输出会去除 ANSI/控制字符、脱敏并按设置截断；超时会终止子进程。它仍继承当前
  操作系统用户权限，不等同于容器或虚拟机级沙箱；
- 桌面浏览器工具使用按对话隔离、无持久 Cookie 的临时 Session；网络导航默认关闭，
  只有逐次审批完整 URL 后才可启用 best-effort public-only 策略。DNS 预检会拒绝已解析
  到私网/本机的目标，并阻止写请求、下载、弹窗和权限请求；由于 Chromium 独立解析域名，
  这不是地址固定或严格 SSRF 隔离，且工具不提供点击、输入、上传、表单提交或登录态复用；
- 第三方 MCP 工具始终逐次人工审批；`readOnlyHint` 等 Server 注解不会使调用自动执行。
  审批绑定 Server、Endpoint、工具 Schema/注解和当前配置版本，绑定变化时旧审批失效；
- MCP 配置（包括可选 stdio 环境变量和 HTTP Header）由桌面端安全存储加密，Renderer
  只接收是否存在凭据的状态；当前 MCP 集成仅实现 Tools，不导入 Resources 或 Prompts；
- stdio MCP Server 仍以当前 OS 用户权限运行，Streamable HTTP Server 的实际网络和
  数据边界由第三方决定，二者都不是可信沙箱；
- 写文件、执行命令、网络发布等重要动作保持用户确认；
- 摘要模型收到最少上下文，敏感数据策略与主模型相同；
- 缓存键包含租户/项目/模型/安全相关参数，禁止跨用户命中。

## 8. Web 与 API

- CORS 使用精确 Origin，不回显任意 Origin，不与通配符 Credentials 混用；
- Helmet/CSP、`nosniff`、frame 限制、Referrer Policy 和安全 Cookie；
- JSON/body、SSE 帧、上传、查询分页均有限制；
- 认证、登录、模型调用、导出和插件安装分别限速；
- 错误响应使用 request ID，不回传堆栈、SQL、上游正文或内部路径；
- 配置代理时处理 `X-Forwarded-*` 的可信跳数，默认不信任；
- 输入经过 Zod，SQL 通过参数化 Repository，HTML/Markdown 输出做 XSS 清洗；
- 浏览器会在初始 URL、重定向和子资源请求上重复执行 DNS 公网地址预检，但实际连接未绑定
  到该预检地址，不能宣称严格阻止 DNS rebinding；严格 SSRF 隔离仍需安全固定出口代理。

## 9. 日志、指标和隐私

默认敏感键名和已知 Token 格式在结构化日志入口统一脱敏。禁止记录：

- Authorization/Cookie、Key/主密钥/口令/代理凭据；
- Prompt/响应/源代码全文；
- 未经同意的邮箱、工作区绝对路径和环境变量值。

指标 label 仅使用低基数维度（状态、路由模板、Provider 类型、模型分组），不使用
用户、会话、request ID。诊断包生成前再次扫描并由用户预览。

日志保留 7 天是默认上限；合规部署按组织策略缩短或集中存储。删除用户数据时，
说明备份保留和到期销毁窗口。

## 10. 供应链与发布

- `pnpm-lock.yaml` 固定直接/间接依赖，CI 使用 `--frozen-lockfile`；
- PR 执行依赖审查，主分支执行 CodeQL、Trivy、密钥扫描和高危审计；
- 发布生成 CycloneDX SBOM、SHA-256、发布清单、GitHub provenance；
- Windows/macOS 安装包必须原生代码签名，macOS 发布需公证；
- 容器为多阶段、非 root、最小运行时，并生成 registry provenance/SBOM；
- CI Secrets 仅在受保护发布环境可用，Fork PR 永远拿不到签名材料；
- Release Tag 版本必须与 `package.json` 一致，发布 Job 不取消进行中任务。

使用者应验证：

```sh
node scripts/release/verify-artifacts.mjs --directory artifacts
cosign verify-blob \
  --bundle artifacts/SHA256SUMS.sigstore.json \
  --certificate-identity-regexp "github.com/.*/.github/workflows/release.yml" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  artifacts/SHA256SUMS
```

## 11. 安全验证清单

- [ ] 主密钥与 Session Secret 不同且来自密钥管理系统
- [ ] TLS、HSTS、CORS、代理可信跳数经过预生产验证
- [ ] 注册策略、角色、限速和审计满足组织要求
- [ ] 插件允许列表及权限审批人已配置
- [ ] 数据库/日志/备份静态加密，恢复演练通过
- [ ] 密钥扫描、依赖审计、CodeQL、Trivy、测试全部通过
- [ ] 安装包签名、公证、SBOM、摘要与 provenance 可验证
- [ ] 告警接收人和安全事件联系人已实测

## 12. 事件响应

1. 立即隔离受影响 Server/插件/发布渠道，保存只读证据。
2. 撤销 Provider Key、访问 Token、CI Token 和签名凭据；不要先删除日志。
3. 按 request ID/审计记录确定租户、数据和时间范围。
4. 使用干净构建环境修复，增加回归测试和 IOC 检测。
5. 发布签名修复版本，通知受影响用户并给出轮换/恢复步骤。
6. 完成无责复盘，更新威胁模型、监控和演练。
