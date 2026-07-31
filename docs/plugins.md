# 插件开发与生命周期

E Agent 插件是包含 `manifest.json` 和 JavaScript 入口的独立目录。插件可以贡献
UI 命令、生命周期 Hook、模型 Provider 和 Tool/Skill 命令。安装、批准、启用是
三个独立动作。

## 目录

```text
my-plugin/
  manifest.json
  dist/
    index.js
  skills/
    my-skill/
      skill.json
      prompts/
        zh-CN.md
        en-US.md
  icons/
    command.svg
```

生产插件应提交构建产物或提供可重复构建流程；运行时不会在安装阶段执行任意
`postinstall`。

## Manifest v1

```json
{
  "schemaVersion": 1,
  "id": "com.example.safe-review",
  "name": "Safe Review",
  "version": "1.0.0",
  "description": "Adds a repository review command.",
  "publisher": "Example",
  "entry": "dist/index.js",
  "engines": {
    "eAgent": ">=0.1.0",
    "node": ">=22"
  },
  "types": ["tool", "hook"],
  "permissions": {
    "fileSystem": {
      "read": ["${workspace}/**"],
      "write": []
    },
    "network": {
      "hosts": ["api.example.com"]
    },
    "env": ["EXAMPLE_TENANT"],
    "notifications": false
  },
  "contributes": {
    "commands": [
      {
        "id": "com.example.safe-review.run",
        "title": "Run safe review",
        "description": "Reviews selected files."
      }
    ],
    "hooks": ["request:before"],
    "skills": [
      {
        "id": "com.example.safe-review.skill",
        "definition": "skills/my-skill/skill.json"
      }
    ]
  }
}
```

严格规则：

- `id`/贡献 ID 使用小写反向域名或带 `.`/`-` 的稳定标识；
- `version` 是 SemVer，Manifest 未知字段会被拒绝；
- 所有路径用 `/`、相对插件根目录，不能包含 `..`、绝对路径或反斜杠；
- `types` 只能是 `ui`、`hook`、`provider`、`tool`，不得重复；
- 权限是上限，不是授权；用户批准前调用仍失败；
- `${workspace}` 文件权限会绑定到规范化工作区根目录的 SHA-256 摘要，授权文件不会保存明文路径；
- Owner/Admin 才能切换工作区。切换后，所有声明 `${workspace}` 的插件会先撤权再停用，必须由 Owner 在新工作区重新批准后才能启用；
- 网络 Host 是主机名白名单，可使用 `*.example.com`，不要写 URL/path；
- 环境变量只能逐项声明，插件无法枚举整个环境。

UI 贡献位置支持 `sidebar`、`toolbar`、`context-menu`，每项引用一个命令。Hook
支持：

- `request:before` / `request:after`
- `file:before-save` / `file:after-save`
- `session:created` / `session:closed`

Hook 应快速、幂等并设置自己的降级策略，不能假设调用顺序或阻塞关闭。

### Server 与 Desktop Hook 触发语义

Server 当前接入以下真实生命周期：

- `request:before`：聊天请求完成认证与请求体校验后、加载 Skill/网页上下文和调用模型前触发；
- `request:after`：非流式请求返回、流式请求结束或聊天链路失败时触发；
- `session:created`：首个 Owner 注册成功或用户登录成功后触发；
- `session:closed`：已认证客户端调用 `POST /api/v1/auth/logout` 时触发。

运行前必须同时满足四个条件：插件已启用、当前 Manifest 已获批准、`types`
包含 `hook`，且 `contributes.hooks` 明确声明本次 Hook。符合条件的插件彼此独立
执行，不保证顺序；单个插件超时、崩溃或抛错不会改变聊天或认证结果。失败只以安全
错误码写入结构化日志和 `plugin.hook.failed` 审计记录，插件原始异常文本不会写入
日志或审计。

Hook 是观察型接口，返回值会被忽略，不能直接改写聊天请求或响应。传入值是经过
严格 schema 校验的受控 JSON 元数据：

- 请求事件只包含事件/请求标识、用户 ID 与角色、流式标志、消息/字符/图片/工具/
  上下文数量和若干存在性布尔值；
- `request:after` 另含 `success`、总耗时、归一化 `errorCode`、会话/消息标识及
  缓存命中状态；
- 会话事件只含注册/登录/退出原因，不含邮箱、显示名或令牌。

Prompt/消息正文、图片 URL、Tool 参数、API Key、`Authorization`、Cookie、密码和
Provider 原始错误均不会传给 Hook。`file:before-save` / `file:after-save` 的严格
元数据契约同样适用于 Desktop：用户整体批准文件提案后，主进程在原子写入前后触发
对应事件。事件只含工作区相对路径、字节数、目标 SHA-256、变更 ID、角色和归一化
结果；不含文件正文、绝对路径或 Diff。文件 Hook 失败会被隔离，不会否决用户批准
的写入。Hook 是尽力而为的观察事件，不与文件系统/数据库提交处于同一事务；插件
不得把它当作持久事件总线。

## 入口 API

```ts
import { definePlugin } from '@e-agent/plugin-sdk';

export default definePlugin({
  async activate(context) {
    const command = context.registerCommand('com.example.safe-review.run', async (input) => {
      context.log('info', 'review started');
      const files = await context.capabilities.fileSystem.list('.');
      return { input, files };
    });

    context.registerHook('session:closed', async () => {
      command.dispose();
      return null;
    });
  },
  async deactivate() {
    // 关闭插件自身定时器、连接和临时资源。
  },
});
```

插件只能使用 `PluginContext` 提供的能力：

- `network.request`：方法、Header、Body 和超时受限；
- `fileSystem.readText/writeText/list`：路径在 Broker 中重新规范化；
- `env.get`：只读取 Manifest 声明且已批准的变量；
- `notifications.show`：需要通知权限；
- `registerCommand/registerHook/registerProvider`：返回可释放句柄；
- `log`：结构化、脱敏日志，字段必须是 JSON 值。

不能把宿主对象、函数、Buffer、Stream 或循环引用放入输入/输出。

## 安装与更新

本地目录安装适合开发。Git 安装只接受无嵌入凭据的 HTTPS URL，可固定 `ref`：

```ts
await runtime.install({ type: 'directory', path: '/absolute/plugin/path' });
await runtime.install({
  type: 'git',
  url: 'https://git.example.com/team/plugin.git',
  ref: 'v1.0.0',
});
```

运行时：

1. 复制/clone 到随机 staging；
2. 限制最多文件数和总大小；
3. 拒绝符号链接、特殊文件和越界入口；
4. 计算规范化目录树 SHA-256；
5. 原子替换已有版本，失败时恢复备份；
6. 返回权限和摘要供用户审批。

更新后只要 Manifest/树摘要改变，组织策略应要求重新审批。不要自动接受新增权限。

## 权限设计建议

- 只读插件不要声明 write；
- 网络限定具体 API 域名，不用宽泛通配；
- 不读取通用 `HOME`、云凭据目录或整个工作区；
- 将用户数据最小化后再发往网络；
- 重要写入仍通过 E Agent Diff/确认流程；
- 对所有外部内容设置最大字节数、超时和 schema；
- 不把 Key 写入插件 data 目录；调用模型应注册 Provider/Tool 让宿主管理凭据。

## 热加载和资源

开发模式监听插件目录，约 300 ms 去抖后重启单个宿主。插件必须：

- 在 `deactivate` 关闭计时器、文件句柄、Socket；
- 把可恢复状态原子写入 `context.dataDirectory`；
- 不依赖进程级全局单例在重启后保留；
- 处理重复命令和中途取消；
- 对长操作观察宿主取消/超时。

## 测试

至少覆盖：

- Manifest 有效/越权/路径穿越；
- 每项能力在未批准、批准、撤销后的行为；
- 命令成功、超时、异常和不可序列化输出；
- 安装上限、符号链接、恶意 Git URL、更新回滚；
- 宿主崩溃、停用、卸载、热加载资源释放；
- 日志中不出现输入 Key 或授权 Header。

示例实现位于 `plugins/code-review`，核心运行时测试位于
`packages/plugin-runtime` 和 `apps/plugin-host`。

## 发布检查表

- [ ] `manifest.json` 通过 SDK schema
- [ ] 版本、兼容范围和变更日志正确
- [ ] 权限最小且有用户可理解的理由
- [ ] 入口与所有贡献文件包含在包内
- [ ] 构建可重复，依赖无高危漏洞
- [ ] 单元/集成测试通过，日志已脱敏
- [ ] Git Tag/提交已固定并由发布者签名
