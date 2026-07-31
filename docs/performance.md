# 性能预算与验证

## 1. 预算

| 路径               | 环境                         | 预算                 |
| ------------------ | ---------------------------- | -------------------- |
| Web 首屏可交互     | 标准测试机、生产构建、热 CDN | p75 < 2 s            |
| Desktop 首窗可交互 | 标准测试机、冷启动           | p75 < 2 s            |
| UI 输入/导航反馈   | 不含模型生成                 | p95 < 100 ms         |
| 非生成 API         | 本地网络、正常数据量         | p95 < 500 ms         |
| SSE 首事件开销     | 不含 Provider 首 Token       | p95 < 200 ms         |
| 队列调度开销       | 未饱和                       | p95 < 20 ms          |
| 常态内存           | 单个 Desktop/Server 主进程   | RSS < 500 MiB        |
| 60 fps 动画帧      | 交互期间                     | 主线程长任务 < 50 ms |

模型首 Token/完成时间受供应商影响，分解为 queue、context、provider 和 render，
不能用端到端单值掩盖应用回归。

## 2. 基准环境

基准报告必须记录：

- Git commit、构建模式、Node/Electron/Chromium 版本；
- OS、CPU 核心、内存、磁盘和电源模式；
- 数据集规模（项目文件、会话/消息、模型/Key、用量记录）；
- 是否冷缓存、网络 RTT/带宽、Provider 是否 mock；
- 样本数、warm-up、p50/p75/p95/p99，而不只平均值。

CI 使用确定性本地 mock，不消耗真实 API 额度。真实 Provider 基准只能手动运行，
使用专用 Key、硬成本上限和脱敏 Prompt。

## 3. 场景

### 首屏

- 生产构建，无 DevTools；
- 冷启动和热启动各至少 20 次；
- Web 采集 Navigation Timing、LCP、INP、CLS、JS/资源字节；
- Desktop 从进程创建到 `app-ready` 标记，分 main/preload/renderer；
- 首屏不等待模型发现、Key 健康或大图表；这些后台加载并有骨架状态。

### 消息

- 1、100、1,000 条消息的会话；
- 1 KiB/100 KiB/1 MiB 上下文；
- 10/100 个 SSE delta 每秒；
- Markdown/代码块、工具调用、取消、断线恢复；
- 记录首事件、渲染长任务、内存增长和 GC。

### 数据

- 10 万用量记录的日/周/月聚合与导出；
- 1,000 会话搜索/置顶/归档；
- SQLite 并发读 + 单写、WAL checkpoint；
- 目录树含 10 万文件时遵守 ignore、大小和取消。

### 扩展

- 20 个已安装插件、5 个启用宿主；
- 插件冷启动、调用、超时、崩溃和热加载；
- 20 Step Workflow 与最大允许变量；
- 确保插件宿主内存单独度量。

## 4. 可执行性能门禁

`tests/performance` 使用 Vitest 和本地合成负载。门禁采用宽松的“算法退化”阈值，
微小系统抖动不应让 CI 随机失败；精确 UI/Web Vital 预算放在专用基准 Runner。

运行：

```sh
pnpm exec vitest run --project cross-cutting tests/performance
pnpm test:e2e:web
```

合并阻断条件：

- O(n) 路径在扩大数据量后出现明显超线性退化；
- SSE 解析丢帧、复制整个累计字符串或超过内存上限；
- 队列超过配置并发、取消后仍启动任务；
- UI bundle/首屏或 RSS 超过基线 10% 且无批准说明；
- 非生成 API p95 超过 500 ms 两次独立基准。

## 5. 设计规则

- SSE 增量解析，TextDecoder 使用 streaming，不为每个字符更新 React；
- Delta 在动画帧/短时间窗批量提交 Store；
- 长会话虚拟化，Markdown 解析缓存按消息 ID/版本；
- Monaco/ECharts 按页面懒加载，销毁 ResizeObserver、事件和实例；
- Zustand selector 精确，避免根 Store 订阅导致全树重渲染；
- 文件读取/哈希/导出使用流和上限，支持 AbortSignal；
- 模型列表、目录树和搜索分页/增量，避免无界 DOM；
- SQLite 索引由真实查询计划验证，事务保持短小；
- 队列有硬上限、背压和取消；重试也占用相同预算；
- 指标 label 低基数，日志序列化不在热路径复制 Prompt。

## 6. 上下文与成本

上下文预算本身也是性能预算：

1. 系统/安全 Prompt 保留固定预算；
2. 当前用户问题和最近消息优先；
3. 文件/网页按语义分数与来源上限装载；
4. 到模型窗口 70% 触发旧消息摘要；
5. 摘要缓存包含源消息版本和模型；
6. UI 显示系统、历史、文件、网页、记忆 Token 占比；
7. 超预算时明确告知丢弃/压缩了哪些来源。

Token 估算和成本计算不能阻塞输入；最终以 Provider usage 校正。

## 7. 分析工具

- Web：Playwright trace、Chrome Performance/Memory、Lighthouse；
- Electron：`--trace-startup`、Chromium trace、Node CPU/heap profile；
- Server：`perf_hooks`、event-loop delay、Clinic/0x（只对脱敏数据）；
- SQLite：`EXPLAIN QUERY PLAN`、WAL/lock 指标；
- Bundle：Vite manifest 与可视化分析。

Heap snapshot、trace 和 profile 可能包含源代码、Prompt、URL 或 Token；视为敏感
Artifact，短期加密保存，分享前脱敏。

## 8. 性能变更报告模板

```text
Commit:
Scenario / dataset:
Environment:
Before p50/p95/RSS/bundle:
After p50/p95/RSS/bundle:
Change:
Profiler evidence:
Correctness tests:
Risk and rollback:
```

任何提高并发、缓存或上下文上限的优化都要同时评估成本、内存、Provider 限速和
跨租户隔离，不能只追求局部延迟。
