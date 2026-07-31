# Security Policy / 安全策略

## 支持版本

| 版本         | 安全更新             |
| ------------ | -------------------- |
| 最新发布版本 | 支持                 |
| `main`       | 尽力支持，不保证稳定 |
| 更早版本     | 不支持               |

## 报告漏洞

请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告功能。若仓库
未启用 Private Vulnerability Reporting，请联系仓库 Owner 并要求建立私密通道。
不要创建公开 Issue，也不要粘贴真实 API Key、主密钥、访问 Token、数据库、完整
日志或用户源代码。

报告应包含：

- 受影响版本、操作系统和部署方式；
- 最小复现步骤与预期/实际结果；
- 影响范围和攻击所需前提；
- 已做过的测试，避免包含真实个人数据；
- 如有补丁，请附最小差异和回归测试。

维护者目标是在 3 个工作日内确认，在 7 个工作日内给出初步分级。修复时间取决
于严重性与供应链依赖。请在公开披露前等待修复版本与协调窗口。

## 范围

范围内：

- Electron 主进程、preload/IPC 权限提升；
- 服务端认证、授权、会话与跨租户数据访问；
- Key 加密、日志泄漏、代理/SSRF、文件路径穿越；
- MCP stdio/Streamable HTTP 传输、配置泄漏、工具审批绕过和不可信结果处理；
- 插件安装、宿主逃逸、权限代理和完整性验证；
- 自动更新、安装包签名、CI/CD 与发布供应链；
- 能导致任意代码执行、密钥泄漏或持久数据损坏的缺陷。

通常不在范围内：仅依赖社会工程、需要已获得 Owner 权限、没有安全影响的 UI
问题、无证据的自动扫描报告、第三方模型自身输出质量。第三方依赖漏洞若在 E
Agent 的可利用路径中仍欢迎报告。

## 安全基线

- 生产环境必须设置不同的 `E_AGENT_SESSION_SECRET` 与
  `E_AGENT_MASTER_KEY`，并由密钥管理系统注入。
- API Key 使用 AES-256-GCM 加密；主密钥丢失将无法恢复历史 Key。
- Web 端永远不接收可解密密钥；任何 `VITE_` 环境变量都视为公开。
- 不在公网设置 `E_AGENT_AUTH_DISABLED=true`。
- 只在已验证反向代理会覆盖转发头时启用 `E_AGENT_TRUST_PROXY=true`。
- 插件默认未授权、未启用；权限或完整性变化后重新审批。
- 桌面浏览器工具只允许隔离会话中的公网 HTTP(S) 只读导航、受限提取和截图；阻止
  私网/本机目标、写请求、下载、弹窗与权限请求，不提供点击、输入、上传或表单提交。
- MCP 仅在 Desktop 运行。只连接可信来源并固定版本/命令；stdio Server 拥有当前
  OS 用户权限，Streamable HTTP Server 的网络与数据边界由其实现决定，二者都不是
  E Agent 的可信沙箱。
- 所有第三方 MCP 工具调用都逐次审批，不因“平衡”工具策略或 Server 提供的
  `readOnlyHint` 等注解而自动执行；注解只是提示，不是独立安全证明。
- MCP 配置（包括可选的 stdio 环境变量和 HTTP Header）由桌面端安全存储加密，
  Renderer 只接收是否存在凭据的状态。不得把 Key、Token 或口令写进 URL、stdio
  参数、日志或截图。
- 当前 MCP 协议集成只实现 Tools；不导入 MCP Resources 或 Prompts。
- 发布必须通过原生代码签名、SBOM、摘要和 Sigstore provenance。
- 备份 SQLite 数据库时同样按敏感数据处理并加密存储。

完整威胁模型见 [docs/security.md](docs/security.md)。

---

## Supported versions

Only the latest release receives security fixes. `main` is supported on a
best-effort basis and may be unstable; older releases are unsupported.

## Reporting

Use GitHub **Security → Report a vulnerability**. If private vulnerability
reporting is unavailable, ask the repository owner for a private channel. Do
not open a public issue and do not include live provider keys, master keys,
access tokens, databases, complete logs, customer source code, or personal
data.

Include the affected version and platform, minimal reproduction, expected and
actual behavior, preconditions, impact, and a regression test when possible.
Maintainers aim to acknowledge reports within three business days and provide
initial triage within seven business days.

Production deployments must use independently generated session and encryption
keys, authentication, a trusted TLS reverse proxy, approved plugin
permissions, encrypted backups, signed installers, SBOMs, checksums, and
provenance. See [the security design](docs/security.md).

The desktop browser tools only provide public HTTP(S) read-only navigation,
bounded extraction, and screenshots in isolated sessions. They block
private/local targets, writes, downloads, popups, and permission requests, and
do not click, type, upload, or submit forms.

MCP is desktop-only. Connect only trusted, version-pinned servers. A stdio
server runs with the current OS user's privileges, while a Streamable HTTP
server defines its own network and data boundary; neither is a trusted E Agent
sandbox. Every external MCP tool call requires explicit per-call approval,
regardless of the selected tool policy or server annotations such as
`readOnlyHint`; those annotations are claims rather than independent proof.
The desktop secret store encrypts MCP configuration, including optional stdio
environment variables and HTTP headers, and the renderer receives only a
credentials-present flag. Never embed secrets in URLs, process arguments,
logs, or screenshots. The current MCP protocol integration supports Tools
only; it does not import MCP Resources or Prompts.
