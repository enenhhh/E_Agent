# E Agent Code Review Plugin

该内置插件提供 `@code-review` Skill 和 `eagent.code-review` 命令。

- 命令先对完整代码或 unified diff 的新增行执行确定性扫描。
- 疑似密钥只报告位置，输出中不会复述凭据。
- Skill Prompt 再由用户选择的模型进行正确性、并发、性能和测试覆盖审查。
- 插件不申请网络、文件系统或环境变量权限；待审查内容必须作为命令输入显式传入。

开发：

```bash
pnpm --filter @e-agent/plugin-code-review test
pnpm --filter @e-agent/plugin-code-review build
```
