# 部署指南

## 1. 选择模式

| 模式            | 适用                       | 数据                     | 入口                |
| --------------- | -------------------------- | ------------------------ | ------------------- |
| Desktop 本地    | 单个开发者、完整工作区能力 | 用户目录 SQLite          | Electron            |
| Compose         | 单机/小团队自建            | Docker 命名卷 SQLite     | TLS 反向代理        |
| Kubernetes 单写 | 受管集群、小团队           | RWO PVC SQLite           | Ingress             |
| 多实例协作      | 大团队                     | 需要未来服务器数据库适配 | 不在 0.1.2 支持范围 |

不要把同一个 SQLite 文件挂载给多个 Server 写副本。Kubernetes 基础清单故意将
Server `replicas` 设为 1，Web 可以横向扩展。

## 2. 生产前准备

1. 建立专用域名和 TLS 证书。
2. 生成不同的 Session Secret 与 32 字节 Master Key：

   ```sh
   export E_AGENT_SESSION_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(48).toString('base64url'))")"
   export E_AGENT_MASTER_KEY="base64:$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64'))")"
   ```

3. 为全新生产数据库另行生成至少 32 字符的 `E_AGENT_BOOTSTRAP_TOKEN`，并与上述密钥
   一起写入 Secret Manager，而不是 `.env`、镜像层、Compose/Kubernetes 清单。首个
   Owner 注册只能通过 `X-E-Agent-Bootstrap-Token` Header 提交它；数据库已有用户后
   Token 自动失效。缺失或错误时注册会安全拒绝。

   Compose/Kubernetes 清单把该 Secret 保持为可选，仅用于让已经初始化的持久化数据库
   在移除一次性令牌后继续重启。全新生产数据库不可省略：此时
   `GET /api/v1/auth/status` 返回 `bootstrapTokenRequired: true`，Web 初始化页会显示
   必填且不持久化的令牌字段；未提供运行时配置时注册始终拒绝。

4. 设置精确 `E_AGENT_ALLOWED_ORIGINS=https://e-agent.example.com`。
5. 仅在反向代理覆盖并清洗 `X-Forwarded-*` 时设置
   `E_AGENT_TRUST_PROXY=true`。
6. 显式设置 `E_AGENT_AUTH_DISABLED=false`。生产环境设置为 `true` 会在配置解析和
   Server 认证初始化阶段被双重拒绝，服务不会开始监听。
7. 配置加密备份、日志收集、告警接收人与恢复演练。
8. 对组织允许的 Provider、代理、插件域名建立白名单。应用层要求云端 Provider
   使用 HTTPS，仅允许 Ollama 通过 HTTP 访问本机回环地址；集群层仍应限制 DNS 和
   egress，防止受信域名解析到非预期网段。

生产配置启动时必须失败于缺失/开发默认密钥，而不是静默退化。

## 3. Desktop

开发构建：

```sh
pnpm install --frozen-lockfile
pnpm --filter @e-agent/desktop build
pnpm --filter @e-agent/desktop start
```

目标系统安装包：

```sh
pnpm validate:installer
pnpm --filter @e-agent/desktop package -- --win nsis
pnpm --filter @e-agent/desktop package -- --mac dmg zip
pnpm --filter @e-agent/desktop package -- --linux AppImage
pnpm verify:desktop-package
```

Windows NSIS 使用带品牌视觉的原生 assisted 界面：首先选择中文或英文，后续页面仅
显示所选语言，静默更新不会覆盖该选择，卸载器也会沿用安装语言。风险告知按语言
加载对应的 UTF-8 原生文本并要求勾选接受；安装范围和目录可修改，全流程不加载
HTML 或浏览器控件。
`deleteAppDataOnUninstall=false` 是有意的安全默认值；卸载器默认保留 `userData` 下的
会话、设置、插件和加密凭据，也允许用户取消保留并在二次确认后永久删除。彻底清理
数据前必须先完成必要备份。

安装器 header、安装/卸载 sidebar 均由 `scripts/assets/generate-icons.mjs` 使用几何
与像素代码确定性生成，不包含图片模型输出或外部版权素材。资源以 3x 分辨率生成，
由 DPI-aware 的 NSIS 原生控件缩放显示。

原生签名必须在对应系统完成。发布后执行：

```sh
node scripts/smoke/smoke-desktop.mjs --platform windows --version 0.1.2
node scripts/smoke/verify-windows-installer.mjs --version 0.1.2
node scripts/release/collect-desktop-artifacts.mjs --output artifacts/windows
```

桌面烟测不仅检查安装包尺寸，还会启动 `win-unpacked`、`.app` 或
`linux-unpacked` 中的真实主程序，等待启动完成标记后退出。Release Workflow 另行
强制校验 Windows Authenticode 与 macOS code signature、公证票据/Gatekeeper。
本地无签名构建可用于功能验证，但不能作为发布产物。

应用数据目录、日志目录和插件目录由 Electron 的 `userData` 根派生。企业分发应
配置系统权限，避免其他普通用户读取，并通过签名策略/MDM 固定更新渠道。

## 4. Docker Compose

构建并启动：

```sh
export E_AGENT_SESSION_SECRET=replace-at-runtime
export E_AGENT_MASTER_KEY=replace-at-runtime
export E_AGENT_BOOTSTRAP_TOKEN=replace-at-runtime
export E_AGENT_ALLOWED_ORIGINS=https://e-agent.example.com
export E_AGENT_WEB_PORT=8080
docker compose build --pull
docker compose up -d
docker compose ps
```

检查：

```sh
node scripts/smoke/smoke-web.mjs \
  --api-url http://127.0.0.1:4318 \
  --web-url http://127.0.0.1:8080
docker compose logs --tail=100 server
```

根 Compose 更适合本机验证。生产中建议：

- Secret 使用 Docker Secret/编排器注入，不使用 Shell 历史中的固定值；
- API 不直接暴露公网，只由同网络反向代理访问；
- 对 `/api/v1/chat/completions` 关闭代理缓冲并延长 read timeout；
- 定期备份 `e-agent-data`，升级前验证备份；
- 镜像使用不可变 digest，不使用浮动 `latest`。

### 反向代理要求

- TLS 1.2+，HTTP → HTTPS，HSTS；
- 请求体上限不高于服务端上限；
- SSE：`proxy_buffering off`、禁用响应缓存、read timeout 覆盖最长生成；
- 只传递受信任 Forwarded Header；
- WebSocket 不是当前 SSE 必需条件；
- 健康端点可供编排器访问，但不要暴露内部依赖细节。

Nginx 核心片段：

```nginx
location /api/ {
  proxy_pass http://server:4318;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_cache off;
  proxy_read_timeout 3600s;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Request-Id $request_id;
}
```

## 5. Kubernetes

基础清单位于 `infra/kubernetes/base`。在环境 Overlay 中至少替换：

- Server/Web image 和 digest；
- 域名、TLS Secret；
- Allowed Origins；
- StorageClass、PVC 大小、资源请求/上限；
- 是否启用 `infra/kubernetes/overlays/hardened-network`，以及目标集群的
  ingress、DNS、Provider、SMTP 与 OTel 放行规则；
- 备份和监控集成。

创建外部 Secret（示例命令不会生成可提交文件）：

```sh
kubectl apply -f infra/kubernetes/base/namespace.yaml
kubectl -n e-agent create secret generic e-agent-secrets \
  --from-literal=session-secret="$E_AGENT_SESSION_SECRET" \
  --from-literal=master-key="$E_AGENT_MASTER_KEY" \
  --from-literal=bootstrap-token="$E_AGENT_BOOTSTRAP_TOKEN"
kubectl apply -k infra/kubernetes/base
kubectl -n e-agent rollout status deployment/e-agent-server
kubectl -n e-agent rollout status deployment/e-agent-web
```

清单默认 non-root、只读根文件系统、drop capabilities、禁止 ServiceAccount Token。
基础清单不会默认启用 NetworkPolicy，因为标准 Kubernetes 规则无法可靠表达
Provider FQDN 白名单，Ingress Controller 与 DNS 标签也因集群而异。仓库提供
`infra/kubernetes/overlays/hardened-network` 作为明确的 opt-in 起点；启用前必须阅读
该目录 README 并在预发布集群验证。生产 Overlay 还应补充：

- default-deny ingress/egress NetworkPolicy；
- 仅允许 DNS、批准 Provider、SMTP、OTel 的 egress；
- PodDisruptionBudget 适用于 Web；单写 Server 维护时允许短暂不可用；
- CSI Secret Store/External Secrets；
- VolumeSnapshot 或应用一致性备份 Job；
- Ingress Controller 的 SSE、限速和 WAF 配置。

## 6. 数据库迁移与升级

发布前：

1. 阅读 Changelog 和迁移；
2. 在生产数据脱敏副本执行迁移和回滚/前向修复演练；
3. 停止新流量并等待活跃 SSE/事务；
4. 执行 SQLite 在线备份，验证 `PRAGMA integrity_check`；
5. 运行 `pnpm db:migrate` 或发布镜像中的等价命令；
6. 启动新版本，等待 ready，再恢复流量；
7. 执行登录、Provider 列表、会话读取、模拟流和用量写入烟测。

迁移一旦写入新格式，不保证旧二进制可读。若 schema 不向后兼容，回滚路径是
恢复升级前备份并回退二进制，而不是只回退容器。

## 7. 发布签名与公证

`.github/workflows/release.yml` 需要受保护发布 Environment 及：

| Secret                         | 用途                                                |
| ------------------------------ | --------------------------------------------------- |
| `WINDOWS_CERTIFICATE`          | Electron Builder 接受的 Windows PFX/Base64/安全 URL |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows 证书口令                                    |
| `MACOS_CERTIFICATE`            | Developer ID Application 证书                       |
| `MACOS_CERTIFICATE_PASSWORD`   | macOS 证书口令                                      |
| `APPLE_ID`                     | 公证账户                                            |
| `APPLE_APP_SPECIFIC_PASSWORD`  | Apple app-specific password                         |
| `APPLE_TEAM_ID`                | Apple Team ID                                       |

配置分支/Tag 保护、必需审批人和最短权限。Fork PR 不可访问这些 Secret。

Tag 必须为 `vX.Y.Z` 且与 `package.json` 一致。工作流生成：

- Windows `.exe`、macOS `.dmg/.zip`、Linux `.AppImage`；
- Web/Server `linux/amd64`、`linux/arm64` 容器；
- `release-manifest.json`、`sbom.cdx.json`、`SHA256SUMS`；
- `SHA256SUMS.sigstore.json` 和 GitHub artifact/container provenance。

验证发布：

```sh
node scripts/release/verify-artifacts.mjs --directory artifacts
cosign verify-blob \
  --bundle artifacts/SHA256SUMS.sigstore.json \
  --certificate-identity-regexp "github.com/.*/.github/workflows/release.yml" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  artifacts/SHA256SUMS
```

Windows 用 `Get-AuthenticodeSignature`，macOS 用 `codesign --verify --deep --strict`
和 `spctl --assess` 做额外原生验证。

## 8. 首次上线验收

- [ ] Release Tag、版本、签名、SBOM、摘要、provenance 验证通过
- [ ] TLS/CSP/CORS/代理 Header/限速经外部扫描验证
- [ ] 注册/登录/角色和审计策略符合组织要求
- [ ] Provider Key 写入后数据库不含明文，日志密钥扫描通过
- [ ] SSE 在代理后可持续并能取消
- [ ] 备份恢复到隔离环境成功
- [ ] Ready/Liveness、错误率、队列、内存和成本告警触发测试成功
- [ ] 插件来源、审批人和允许权限已记录
- [ ] 桌面三平台安装、启动、更新和卸载验证通过
