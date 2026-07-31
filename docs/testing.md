# 测试策略

## 测试金字塔

| 层          | 工具                      | 目标                                         |
| ----------- | ------------------------- | -------------------------------------------- |
| 单元        | Vitest                    | schema、Store、领域策略、SSE、加密、插件权限 |
| 集成        | Vitest + 临时 SQLite/HTTP | Repository、Provider mock、队列、宿主协议    |
| 契约        | OpenAPI + Zod             | 路由、DTO、SSE 事件和兼容                    |
| E2E Web     | Playwright Chromium       | 登录、流式消息、服务商级联、工具卡、设置     |
| E2E Desktop | Playwright Electron       | 安全生产入口、IPC、ABI、窗口生命周期         |
| 安全/供应链 | Vitest + CI               | 密钥、路径、权限、摘要/签名、依赖            |
| 性能        | Vitest/Playwright 基准    | 预算、算法退化、首屏、内存                   |

`pnpm test:coverage` 先生成全仓报告，再对 contracts/config/security/observability、
AI runtime、core、database、plugin runtime/host/SDK、skills、desktop、app-ui 和
内置插件逐包执行阈值。核心模块语句、函数和行覆盖目标不低于 80%，分支按风险设为
70–80%；覆盖率不替代断言质量。加密、授权、额度、插件 Broker、文件写入等高风险
分支应接近完整分支覆盖。

## 本地命令

```sh
pnpm test
pnpm test:watch
pnpm test:coverage
pnpm test:e2e:web
pnpm test:e2e:desktop
```

单包：

```sh
pnpm --filter @e-agent/security test
pnpm --filter @e-agent/plugin-runtime test
```

跨模块：

```sh
pnpm exec vitest run --config tests/vitest.config.ts
```

## Fixture 与 Provider

- 普通 CI 不调用真实模型 API；
- 使用本地 HTTP Server 模拟 model list、SSE 分片、429、5xx、超时和断开；
- 同时覆盖标准流式/最终 `tool_calls`，以及严格受限的 error-only 兼容恢复；未知函数、
  多调用、重复/危险字段、标签注入、尾随正文、超限输入和普通内容混入都必须拒绝；
- 密钥 fixture 在运行时拼接，不能在仓库出现真实 Key 格式；
- 临时 SQLite/目录由测试创建并在 `afterEach` 清理；
- 时间、随机、重试抖动应注入或使用 fake timer；
- 不以 sleep 等待异步状态，等待可观察事件/条件；
- 测试不能依赖执行顺序或开发者已有配置。

真实供应商测试属于手动评估：专用 Key、硬日成本、最短 Prompt、不上传用户代码，
结果不作为确定性 PR 门禁。完整验收从 UI 添加服务商和 Key 开始，依次验证发现后只显示
该服务商模型、流式 Thinking、只读工具、写文件 Diff 审批、命令单独审批、工具卡结果、
磁盘精确内容和重启后持久化；证据不得包含 Key、Prompt 正文或 Provider 原始错误体。

## E2E 选择器

优先可访问 role/name；复杂组件使用稳定 `data-testid`：

- `login`
- `workspace`
- `message-input`
- `send-message`

测试不使用 CSS 层级、动态 class 或中文文案作为唯一选择器。中英文各验证一个
核心路径，键盘操作与可访问名称同时覆盖。

Web 测试通过 Playwright route/mock 隔离 Provider；Desktop 设置
`E_AGENT_E2E=1`，禁用自动更新和外部副作用，窗口标题固定为 `E Agent`。

Desktop E2E 和打包入口会先将 `better-sqlite3` 重建到 Electron ABI，并在 Electron
进程中执行内存查询；无论成功或失败，结束时都会恢复到当前 Node ABI 并再次执行内存
查询。不要直接使用 `electron-builder` 或用 Electron 的 `-p/-e` 参数代替项目脚本。

## 契约

`infra/openapi/e-agent.v1.json` 是公开 HTTP 契约，`packages/contracts` 是运行时
类型契约。变更顺序：

1. 先写失败的契约/兼容测试；
2. 更新 Zod 与 OpenAPI；
3. 更新 Server、Desktop IPC、Web Client；
4. 验证旧可选字段/响应仍可读取；
5. 破坏性变更发布新 API/schemaVersion。

SSE 测试必须覆盖任意字节边界分片、CRLF、注释心跳、多行 data、UTF-8 跨块、
错误事件、done 和客户端取消。

## 安全回归

至少包含：

- AES-GCM roundtrip、错误 AAD/密钥/篡改拒绝；
- 日志/错误/序列化深度脱敏，Provider 响应体、工具参数、文件内容和命令输出不得落盘；
- 过期/篡改 Token、角色矩阵和跨用户资源 ID；
- CORS、限速、body 上限、SSRF/重定向；
- 工作区/插件路径穿越、符号链接、网络/环境权限；
- 写文件必须先产生 Diff 且审批后才落盘；命令始终单独审批、`shell:false`、参数数组、
  允许列表、超时、输出上限和工作区版本绑定；
- Provider 非标准工具信封只有在错误类型、单个已声明函数和 Schema 全部匹配时才能
  恢复，解析失败必须返回脱敏错误且不能伪装成“执行完成”；
- Git URL 凭据、安装上限、权限变更后审批失效；
- 发布 Artifact 篡改与签名验证。

## CI 失败 Artifact

CI 仅在失败时上传短期 Playwright trace、截图和视频。覆盖率/SBOM 有独立保留期。
诊断 Artifact 可能包含敏感内容：

- 测试只使用虚构账户和合成源代码；
- 禁止录制真实 Key/生产响应；
- 失败 Artifact 只对仓库维护者开放；
- 7 天后自动删除；
- 安全事件时按证据保留流程转存。

## 合并门禁

- 格式、Lint、TypeScript、单元/集成/契约/安全全部通过；
- 核心覆盖率达到阈值且没有无解释下降；
- Web/Desktop 主流程 E2E 通过；
- 无高危依赖、CodeQL/Trivy 阻断项或疑似密钥；
- 架构/API/插件/Skill/运维文档与行为一致；
- 性能预算没有超过批准阈值；
- 发布变更在目标原生 Runner 完成签名烟测。
