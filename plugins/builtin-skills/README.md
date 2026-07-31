# E Agent Built-in Skills

本插件提供 E Agent 的十一个内置技能：

- `@bug-fix`：基于复现与根因证据实施最小修复，并补充回归测试。
- `@architect`：设计模块边界、数据流、可靠性策略和渐进迁移方案。
- `@refactor`：在测试保护下保持行为并降低复杂度、重复和耦合。
- `@security-audit`：沿信任边界和数据流审计安全问题并给出最小修复。
- `@browser-research`：通过真实浏览器来源检索、交叉核验并引用最新资料。
- `@computer-operator`：逐步观察和操作桌面应用，在高影响动作前请求确认。
- `@doc-gen`：从函数、类或模块源码生成完整的中英文开发文档。
- `@test-gen`：识别 Jest、Vitest、PyTest 或 GoTest，并生成可运行的单元测试。
- `@db-helper`：把自然语言需求转换为 MySQL、PostgreSQL、MongoDB 或 SQLite 查询。
- `@deploy`：生成带健康检查、安全基线和资源限制的 Docker、Compose 与 Kubernetes 配置。
- `@explain`：逐段解释代码，并标注时间复杂度、空间复杂度和风险边界。

每个 Skill 都包含严格的 `skill.json`、中英文 Prompt 和一个无外部权限的确定性预分析命令。预分析只提取输入中可验证的事实；最终语义生成由用户选择的模型完成。插件不申请网络、文件系统、环境变量或通知权限。

## 开发

```bash
pnpm --filter @e-agent/plugin-builtin-skills test
pnpm --filter @e-agent/plugin-builtin-skills build
```

## Workflow

十一个技能可以被 Workflow 编排器串联。后续步骤可通过 `{{steps.<step-id>}}` 使用前序输出，首个步骤通过 `{{input.source}}` 接收运行时输入。例如：

```text
@code-review → @test-gen → @deploy
```
