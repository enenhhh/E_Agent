# Skill 与 Workflow 开发

当前 `plugins/builtin-skills` 提供 11 个双语 Skill：`@bug-fix`、`@architect`、
`@refactor`、`@security-audit`、`@browser-research`、`@computer-operator`、
`@doc-gen`、`@test-gen`、`@db-helper`、`@deploy` 和 `@explain`。仓库另附独立的
`@code-review` 示例 Skill 插件。Web 端支持创建、持久化、运行和删除线性 Workflow；
底层 Schema 与执行器也支持一般 DAG。运行历史、失败恢复和步骤级取消尚未实现。

Skill 是可审计的双语 Prompt 资产；Workflow 把多个 Skill 按有向无环图串联。与
插件不同，纯 Skill 不执行代码。需要代码执行时，通过 `executor` 显式关联一个
已安装、已批准的插件命令。

## Skill 目录

```text
plugins/
  code-review/
    skill.json
    prompts/
  builtin-skills/
    manifest.json
    skills/
      doc-gen/
        skill.json
        prompts/
      bug-fix/
      architect/
      refactor/
      security-audit/
      browser-research/
      computer-operator/
      test-gen/
      db-helper/
      deploy/
      explain/
```

`skill.json` 示例：

```json
{
  "schemaVersion": 1,
  "id": "com.eagent.doc-gen",
  "command": "@doc-gen",
  "name": {
    "zh-CN": "文档生成",
    "en-US": "Documentation Generator"
  },
  "version": "1.0.0",
  "description": {
    "zh-CN": "为函数、类或模块生成完整文档。",
    "en-US": "Generate complete documentation for code."
  },
  "prompts": {
    "zh-CN": "prompts/doc-gen.zh-CN.md",
    "en-US": "prompts/doc-gen.en-US.md"
  },
  "variables": [
    {
      "name": "code",
      "description": "需要生成文档的完整源码",
      "required": true,
      "maximumLength": 1000000
    }
  ],
  "output": "markdown",
  "timeoutMs": 120000
}
```

规则：

- `id` 是稳定小写命名空间，`command` 使用 `@kebab-case`；
- `name`、`description`、Prompt 必须同时提供 `zh-CN` 和 `en-US`；
- Prompt 路径相对 Skill 根，不能绝对、反斜杠或包含 `..`；
- 变量名使用 lowerCamelCase，逐项限制长度，未知变量拒绝；
- 输出只能是 `json`、`markdown`、`text`；
- 超时 1–300 秒，默认 60 秒；
- Skill 版本是三段 SemVer，变更输入/输出语义时升级版本。

## Prompt 模板

模板只替换已声明变量：

````md
你是严格的代码审查员。

项目上下文：
{{context}}

待审查代码：

```text
{{code}}
```

请按严重程度输出：位置、证据、影响、最小修复和测试建议。
````

变量按文本注入，不应动态生成新的模板表达式。外部文件/网页内容需在 Prompt 中
明确标记为不可信数据，不能让其覆盖系统规则。避免要求模型暴露思维链；要求简洁
证据和可验证结论。

JSON 输出 Skill 应在 Prompt 中声明 schema，并在执行后用运行时 schema 验证。
验证失败可做一次受限修复请求，不能无限重试。

## 分层系统提示词

Skill Prompt 不会单独成为最高优先级指令。聊天服务先构建一条版本化基础 system
消息，再合并已选择的 Skill 与上下文 system 消息：

1. 身份与目标：区分事实、推断、计划和真实执行结果；
2. 安全与授权：把网页、文件、终端和工具结果作为不可信数据；
3. 工具调用：仅列出本轮实际暴露的工具，并要求只读优先、参数校验与验证；
4. 上下文与证据：区分 Desktop/Web 能力和上下文来源；
5. 任务场景：按 general、bug-fix、architect、refactor、security-audit、
   browser-research 或 computer-operator 选择策略；
6. 输出约定：先结果后证据，不把未运行的检查描述为完成。

基础消息带版本标记，模型—工具循环重复进入聊天服务时不会再次注入。Skill 可以细化
任务步骤和输出格式，但不能扩大工作区、网络、电脑或 MCP 权限；真正的边界仍由 IPC
Schema、审批、工具运行时和输出上限执行。系统提示词也不能保证第三方模型始终服从，
因此不得用 Prompt 替代确定性校验。

## 插件执行器

需要数据库检查或外部工具时添加：

```json
{
  "executor": {
    "pluginId": "com.example.database-tools",
    "commandId": "com.example.database-tools.inspect"
  }
}
```

这不会绕过插件权限。Desktop resolver 会在插件已安装、已批准且已启用时运行
确定性预分析命令，再把结果附加到模型 Prompt。Server 当前执行声明式 Prompt，
不会调用 `executor`；因此 Server 运行不应依赖执行器副作用。

## Workflow

```json
{
  "schemaVersion": 1,
  "id": "com.eagent.workflow.document-explain",
  "name": "Document → Explain",
  "steps": [
    {
      "id": "document",
      "skillId": "com.eagent.doc-gen",
      "dependsOn": [],
      "input": {
        "code": "{{input.source}}"
      }
    },
    {
      "id": "explain",
      "skillId": "com.eagent.explain",
      "dependsOn": ["document"],
      "input": {
        "code": "{{steps.document}}"
      }
    }
  ]
}
```

Workflow schema 会拒绝：

- 重复 Step ID；
- 指向不存在 Step 的依赖；
- 自依赖或间接环；
- 未声明依赖却读取其他 Step 输出；
- 不存在的 Skill、未知变量或缺失的必填变量；
- `process.env` 等不受支持的模板表达式；
- 超过 20 个 Step；
- 读取尚未执行 Step 的输出。

当前执行器按稳定拓扑顺序串行运行。Workflow 定义保存到 Settings Repository，
Server 重启后会重新校验再加载；损坏或引用已删除 Skill 的定义会被跳过并记录警告。
Web UI 创建的是便于理解的线性流程，API 和 `WorkflowRegistry` 可保存一般 DAG。

### HTTP API

| 方法     | 路径                        | 权限               | 用途           |
| -------- | --------------------------- | ------------------ | -------------- |
| `GET`    | `/api/v1/workflows`         | 已登录             | 列出已保存定义 |
| `POST`   | `/api/v1/workflows`         | Owner/Admin        | 校验并保存定义 |
| `PUT`    | `/api/v1/workflows/:id`     | Owner/Admin        | 覆盖同标识定义 |
| `DELETE` | `/api/v1/workflows/:id`     | Owner/Admin        | 删除定义       |
| `POST`   | `/api/v1/workflows/:id/run` | Owner/Admin/Member | 运行已保存定义 |

保存、运行和删除会写入不含用户输入内容的审计日志。Viewer 只能查看定义。

## 失败、取消和成本

当前行为：

- 每个 Skill 使用定义中的超时创建 `AbortSignal`；
- Workflow 在第一处错误停止，不执行后续依赖；
- 已完成输出只在本次响应中返回；错误响应不会返回可恢复快照；
- 没有 Workflow 级自动重试、成本预估、Step 用量关联或外部取消接口。

目标行为是在持久化 Workflow 快照后从失败 Step 恢复，并校验前序输出、
Workflow schema 与 Skill 版本；该能力尚未实现。

## 内置 Skill 输出约定

- `@code-review`：按优先级列出有证据的问题、位置、影响、修复与测试；
- `@bug-fix`：复现线索、根因证据、最小修复、回归测试与相邻路径检查；
- `@architect`：约束、质量属性、边界、数据流、迁移路径、失败模式与取舍；
- `@refactor`：在测试保护下保持行为，识别复杂度、耦合和可变状态；
- `@security-audit`：按信任边界和数据流验证风险、影响、前提与最小修复；
- `@browser-research`：限定时效和来源，使用真实浏览器工具交叉核验并引用；
- `@computer-operator`：把操作拆为可观察步骤，对外部提交和高影响动作先确认；
- `@doc-gen`：中文 API 文档、参数、返回、异常、示例与边界；
- `@test-gen`：检测框架，生成可执行测试和必要 fixture；
- `@db-helper`：明确方言，参数化 SQL，标注只读/写入风险；
- `@deploy`：Docker、Compose、Kubernetes 和密钥注入说明；
- `@explain`：逐段解释及时间/空间复杂度；
- 所有内置 Skill 在信息不足时都必须明确假设，不伪造运行结果。

11 个 Skill 位于 `plugins/builtin-skills`，共享一个不申请网络、文件系统、环境变量
或通知权限的插件。每个命令先做确定性预分析，例如故障证据提取、架构约束识别、
复杂度与安全模式扫描、研究/电脑操作边界提取、符号提取、测试框架推断、数据库风险
分类、部署运行时识别或控制流复杂度统计。`@browser-research` 和
`@computer-operator` 只是规划与约束 Prompt；只有本轮实际提供的桌面工具才能执行
浏览或电脑读取，它们不会绕过审批，也不提供通用键鼠控制。

## 测试

每个 Skill 至少维护：

- schema/注册测试；
- 中英文模板变量完整性与未知变量拒绝；
- 一组正常输入、一组恶意 Prompt 注入、一组超长输入；
- JSON 输出 schema 测试（如适用）；
- 快照或语义断言，避免只比较易波动全文；
- 固定模型/温度的离线录制回归，不在普通 CI 消耗真实 API 额度；
- 需要真实 Provider 的评估只在手动受限流水线运行并设置成本上限。

不要将真实项目源代码、Key 或供应商响应加入测试 fixture。
