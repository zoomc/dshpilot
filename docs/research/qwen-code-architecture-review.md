# Qwen Code 源码与架构研究

## 调查基线

- 仓库：[QwenLM/qwen-code](https://github.com/QwenLM/qwen-code)
- 分支：main
- Commit：[c396fe3d12db4ee0683209578d9fce2b3a96b94f](https://github.com/QwenLM/qwen-code/commit/c396fe3d12db4ee0683209578d9fce2b3a96b94f)
- 版本：0.21.11
- Node：>=22

## 关键源码

| 领域 | 参考路径 | 可借鉴点 |
|---|---|---|
| Agent Core | [agent-core.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/agents/runtime/agent-core.ts) | 共享推理循环，宿主生命周期分离 |
| Agent events | [agent-events.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/agents/runtime/agent-events.ts) | 强类型 start/round/tool/approval/finish/error |
| Tools | [tools.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/tools/tools.ts) | schema、权限、确认、执行、结果统一 |
| Registry | [tool-registry.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/tools/tool-registry.ts) | built-in、lazy、MCP、命令发现统一注册 |
| Scheduler | [coreToolScheduler.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/core/coreToolScheduler.ts) | 只读并行，写入/执行串行 |
| Permission | [permissionFlow.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/core/permissionFlow.ts) | 多层 allow/ask/deny |
| Settings/Trust | [settings.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/cli/src/config/settings.ts)、[trust-precedence.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/cli/src/config/trust-precedence.ts) | 配置来源、workspace trust |
| MCP | [mcp-client-manager.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/tools/mcp-client-manager.ts) | 健康检查、重连、跨 session transport |
| Memory | [packages/core/src/memory](https://github.com/QwenLM/qwen-code/tree/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/memory) | user/project/team scope、secret scan |
| Skills | [skill-manager.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/skills/skill-manager.ts) | SKILL.md 发现、缓存、优先级 |
| Subagents/Teams | [subagent-manager.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96f/packages/core/src/subagents/subagent-manager.ts)、[TeamManager.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/core/src/agents/team/TeamManager.ts) | agent identity、深度、父子路由 |
| Sandbox | [sandbox.ts](https://github.com/QwenLM/qwen-code/blob/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/cli/src/utils/sandbox.ts) | macOS Seatbelt、Docker、Podman |
| ACP/Daemon | [acp-bridge](https://github.com/QwenLM/qwen-code/tree/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/acp-bridge/src)、[serve](https://github.com/QwenLM/qwen-code/tree/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/cli/src/serve) | REST/SSE/WS、session demux、replay |
| SDK/IDE | [sdk-typescript](https://github.com/QwenLM/qwen-code/tree/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/sdk-typescript/src)、[VS Code companion](https://github.com/QwenLM/qwen-code/tree/c396fe3d12db4ee0683209578d9fce2b3a96b94f/packages/vscode-ide-companion/src) | 多宿主接入 |

## 核心架构思想

~~~text
CLI / TUI / Headless / IDE / SDK / Daemon
  -> Config + Trust
  -> Session + transcript
  -> AgentCore
  -> ToolRegistry
  -> Permission + Sandbox
  -> Built-in / MCP / Skill / Subagent
  -> Typed Events
~~~

1. AgentCore 只做模型轮次和工具调度，不负责宿主生命周期。
2. Event-first：UI、SSE、SDK、IDE 都消费同一组强类型事件。
3. ToolRegistry 是工具唯一事实来源，支持 lazy materialization、MCP discovery、禁用、冲突检查和稳定顺序。
4. 工具可见性、权限、workspace trust、sandbox、MCP server approval 分层。
5. 普通配置与安全优先级分离；配置结果应记录 value、source、trusted。
6. Daemon 用 event bus、Last-Event-ID、replay window 和 session client id 支持断线恢复。
7. 多 agent 通过显式 agent id、depth、parent identity 传播上下文。

## 对 DSHPilot 最有价值的部分

- 为 Desktop/Remote Control Plane 定义 typed event contract。
- 统一 MCP、document、notification、remote operation 的 ToolRegistry/adapter 语义。
- 为配置保留来源和信任信息，避免“最后合并值”无法解释。
- 将 workspace trust 作为 MCP、document、remote command 的前置条件。
- 采用 lazy tool discovery、工具 schema 校验、inflight 防重复初始化。
- 对只读与写入工具采用不同调度策略。
- 采用 session client id、Last-Event-ID、bounded replay。
- 子任务使用稳定 parent/child/agent identity，限制最大深度。
- sandbox 作为宿主安全层，不把 approval 当成 sandbox。

## 不能照搬的部分

- 不要复制 Qwen 的完整功能数量和复杂 Teams。
- 不要把 Gemini/Google 历史抽象当成 DSHPilot 的核心接口。
- 不要把同用户 ACP 子进程当作强隔离。
- 不要一开始引入全量 OpenTelemetry。
- 不要把显式 MCP 配置自动视为可信，remote 场景仍要做来源和 workspace 检查。

## 对 DSHPilot 的具体改进

### Phase 1

- 增加事件类型和 error schema。
- 建立 workspace trust、路径 containment、symlink 防护。
- 将 MCP 配置解析、runtime manifest、document manifest 都保留 source/version。
- 为 Supervisor/Runtime/Remote future API 增加 session/client/request correlation。

### Phase 2

- MCP Manager 增加 server scope、allowlist、health/reconnect、tool budget。
- Documents 以 lazy provider/tool 方式发现，默认 manifest-only。
- Token Inspector 消费真实 usage event，并显示 source/estimate。
- Skills/Memory 如果 upstream 没有成熟实现，再做 user/project scope；memory 写入默认审批，增加 secret scan。

### Phase 3

- Remote API 使用 SSE/WS replay。
- workspace trust 与 device scope 组合判断。
- 子任务显示 parent/child identity，但不重写 Harness Agent/Session 事实。
- sandbox capability 通过 host profile 传递，不让 PWA 直接获得 OS 权限。

## 验收测试

- 配置来源和 trust 变化会改变最终有效权限。
- 未信任 workspace 的 MCP project config 不启动子进程。
- symlink、绝对路径、.. 穿越都失败。
- lazy tool 并发初始化只执行一次。
- read/search 可并行，write/exec 串行且顺序稳定。
- SSE 断线后 Last-Event-ID 只补发缺失事件。
- tool schema 变更后旧 snapshot 的 stale call 不执行。
- 子 agent 超过最大深度得到结构化拒绝。
