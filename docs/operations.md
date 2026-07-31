# 运维手册

## 1. 服务目标

0.1.2 推荐的初始目标：

| 指标                           | 目标                              |
| ------------------------------ | --------------------------------- |
| API 可用性（不含 Provider）    | 月度 99.9%                        |
| 非生成 API p95                 | < 500 ms                          |
| Web 首屏（标准测试机、热 CDN） | < 2 s                             |
| 主进程常态 RSS                 | < 500 MiB                         |
| 服务端 5xx                     | 5 分钟窗口 < 1%                   |
| 请求队列                       | p95 等待 < 2 s，深度不持续超过 50 |
| RPO / RTO                      | 默认 24 h / 4 h；按组织提高       |

Provider 延迟/错误单独统计，不应掩盖 E Agent 自身错误，但用户 SLO 可以包含端到
端成功率。

## 2. 日常检查

每日：

- `/health/live`、`/health/ready` 和外部登录/流式合成探针；
- 5xx、401/429 异常、队列深度、事件循环延迟、RSS、磁盘/PVC；
- Provider 成功率、p95、重试、Key 绿/黄/红分布；
- 日成本/Token、异常用户/项目增量、配额暂停；
- 备份 Job 和最后成功时间。

每周：

- 高危依赖/CodeQL/Trivy/密钥扫描；
- SQLite `integrity_check`、WAL/数据库增长；
- 失效用户、插件权限、审计异常；
- 恢复一个随机备份到隔离环境；
- 证书、域名、代码签名和 Provider Key 到期。

## 3. 健康端点

`/health/live` 只回答进程是否存活，不检查慢外部 Provider。失败时编排器可重启。

`/health/ready` 检查接受请求必需的配置、数据库与迁移。失败时应从负载均衡摘除，
但不要立即循环重启导致证据丢失。响应不得暴露文件路径、Key 或 SQL。

外部合成探针还应完成：

1. 登录测试用户；
2. 读取模型/会话列表；
3. 使用本地 mock/专用低成本模型发起短 SSE；
4. 验证 `done` 和用量落库；
5. 删除测试会话。

合成账户和额度与真实用户隔离。

## 4. 日志与关联

日志为 JSON/结构化字段，至少包含 timestamp、level、service、requestId、route、
status、durationMs 和稳定 errorCode。排障从用户可见 request ID 开始。

禁止日志字段：Authorization、Cookie、Key/Secret/Token/Password、Prompt/响应
全文、源代码、完整邮箱、环境变量、密文信封。支持包导出前运行二次密钥扫描。

默认保留 7 天并轮转。集中日志系统设置：

- 写入时 TLS 和存储加密；
- 基于角色的最小访问；
- 不用 request/user/conversation 作为高基数指标 label；
- 审计日志与普通调试日志分开控制删除；
- 时钟同步和不可变保留满足组织取证策略。

## 5. 指标与告警

Prometheus 配置/初始规则见 `infra/observability`。建议指标：

- `e_agent_http_requests_total{route,method,status}`
- `e_agent_http_request_duration_ms{route,method}`
- `e_agent_provider_requests_total{provider,status}`
- `e_agent_provider_duration_seconds{provider,model_group}`
- `e_agent_queue_active`
- `e_agent_queue_pending`
- `e_agent_request_queue_wait_seconds`
- `e_agent_tokens_total{direction,provider,model_group}`
- `e_agent_estimated_cost_usd_total{provider,model_group}`
- `process_resident_memory_bytes` / Node runtime 指标

告警至少覆盖 Server Down、5xx、队列饱和、内存接近预算、磁盘不足、备份失败、
Key 大面积红色、成本突增和证书到期。

## 6. 备份与恢复

备份包含：

- SQLite 数据库的一致性快照；
- 插件审批/状态和项目记忆；
- 必需配置的版本化副本（不把 Secret 混入普通备份）；
- 恢复所需的主密钥，由独立 Secret 备份策略托管。

主密钥与数据库备份不可只保留其中之一。主密钥丢失无法恢复 Provider Key；主密钥
泄漏则所有密文都视为泄漏。

恢复演练：

1. 新建隔离主机/Namespace，不覆盖生产；
2. 校验备份摘要并恢复数据库；
3. 通过安全通道注入对应主密钥；
4. 运行 `PRAGMA integrity_check` 和迁移状态检查；
5. 启动同版本，验证登录、会话、Key 解密健康检查；
6. 升级到目标版本并执行烟测；
7. 记录实际 RPO/RTO，安全销毁演练数据。

## 7. 常见事件

### Ready 失败

1. 查看最近配置/迁移变更和 request ID 日志；
2. 检查数据库路径可写、磁盘、文件权限和锁；
3. 确认 Master Key/Session Secret 格式，不打印值；
4. 若迁移失败，停止写流量并按迁移手册恢复；
5. 不用反复重启掩盖确定性配置错误。

### SSE 大面积断开

1. 区分浏览器取消、Ingress timeout、Server timeout、Provider 断流；
2. 检查代理 buffering/read timeout 和连接数；
3. 对照 queue wait、event loop、Provider p95；
4. 降低并发或切换健康 Key/Provider；
5. 使用幂等键恢复，不重复写消息/计费。

### 429/配额耗尽

1. 查看 Key 池健康、日/月额度和 Provider rate-limit Header；
2. 确认轮询没有持续选择已暂停 Key；
3. 降低并发，按 `Retry-After` 退避，不无限重试；
4. 通知 Owner，并记录成本/配额决策；
5. 不临时移除额度保护解决容量问题。

### 内存 > 500 MiB

1. 记录 RSS、heap、活跃流、上下文大小、插件宿主；
2. 停止新重任务，保留 heap snapshot 前先评估敏感数据；
3. 检查无界消息、ECharts/Monaco 实例、流 Buffer、监听器和插件；
4. 单独停用异常插件；必要时有序重启；
5. 用脱敏合成数据复现并加入性能回归。

### 疑似 Key 泄漏

1. 立即撤销供应商 Key 和关联代理凭据；
2. 隔离实例，保留审计/访问日志和发布信息；
3. 轮换 Session Secret；评估是否需要轮换 Master Key；
4. 搜索数据库导出、备份、崩溃转储、日志和 CI Artifact；
5. 新建最小权限 Key，通知受影响用户并复盘。

### 插件异常

1. 停用插件宿主，撤销审批，不直接删除证据；
2. 记录 Manifest、完整性摘要、来源 ref、宿主日志；
3. 检查网络/文件/环境能力调用与审计；
4. 将插件移入隔离，轮换它可能访问的凭据；
5. 只有在新版本审查并重新批准后恢复。

## 8. 数据维护

- 监控数据库和 WAL 增长；长读事务会阻止 checkpoint；
- 用量/审计按策略归档，不执行无界 `DELETE` 阻塞服务；
- VACUUM 需要额外磁盘和维护窗口；
- 删除用户/项目应在事务中处理关联数据，并记录审计；
- 每 50 条消息自动快照的保留策略需按实际存储增长调整；
- 导出 PDF/CSV 属于重任务，进入队列并限制时间范围。

## 9. 密钥轮换

Session Secret：

1. 通知维护窗口；
2. 部署新 Secret 并滚动 Server；
3. 所有旧 Token 失效，用户重新登录；
4. 验证认证告警回归。

Master Key：

1. 备份并验证恢复；
2. 生成新 32 字节 Key，旧 Key 仍只读可用；
3. 维护任务逐条解密/重新加密，并验证 GCM；
4. 原子切换当前 Key ID；
5. 观察至少一个备份周期，再销毁旧 Key；
6. 记录审计但不记录任何 Key material。

## 10. 升级与回滚

只升级到已验证签名、SBOM、摘要和 provenance 的版本。Canary 先验证：

- 启动自检/Ready；
- 登录、角色和会话；
- Provider 发现、短 SSE、工具调用；
- Key 创建/健康/配额；
- 用量统计/导出；
- 插件启停和文件 Diff；
- CPU、RSS、首屏和非生成 API p95。

若迁移向后兼容，可回退二进制；否则恢复升级前备份。任何回滚都记录时间、原因、
数据处理和后续修复。
