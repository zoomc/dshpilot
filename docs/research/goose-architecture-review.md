# Goose 源码与架构研究

## 调查基线

- 原仓库：[block/goose](https://github.com/block/goose)
- 当前归属仓库：[aaif-goose/goose](https://github.com/aaif-goose/goose)
- 分支：main
- Commit：[3810898a7447ec3299be72e223d3570a7aabf0ab](https://github.com/aaif-goose/goose/commit/3810898a7447ec3299be72e223d3570a7aabf0ab)
- 重点：Rust agent runtime、MCP extensions、ACP server、Electron desktop、keyring/update/release。

## 关键源码

| 领域 | 参考路径 | 可借鉴点 |
|---|---|---|
| Runtime | [crates/goose/src/lib.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/lib.rs) | 聚合 agent、conversation、permission、session、recipe、skills |
| State machine | [crates/goose-agent/src/machine.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose-agent/src/machine.rs) | operation/effect、cancel、yield、resume |
| Conversation | [conversation.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose-provider-types/src/conversation.rs) | agent-visible/user-visible projection |
| Session | [session_manager.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/session/session_manager.rs) | SQLite WAL、migration、usage ledger、恢复 |
| Provider | [provider-types/base.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose-provider-types/src/base.rs) | provider/model/config/usage 类型 |
| Extensions | [extension.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/agents/extension.rs) | stdio、HTTP、builtin、frontend、inline Python |
| Extension manager | [extension_manager.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/agents/extension_manager.rs) | tool list、分页、allowlist、owner、schema、duplicate |
| Permission | [permission_inspector.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/permission/permission_inspector.rs) | AlwaysAllow/AskBefore/NeverAllow 与 action-required |
| Developer tools | [developer extension](https://github.com/aaif-goose/goose/tree/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/agents/platform_extensions/developer) | shell timeout、cancellation、output limit |
| Recipes/skills | [recipe](https://github.com/aaif-goose/goose/tree/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/recipe)、[skills](https://github.com/aaif-goose/goose/tree/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/skills) | 参数校验、路径安全、支持文件 |
| Subagents | [subagent_handler.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/agents/subagent_handler.rs) | max turns、工具可见性、递归限制 |
| ACP server | [crates/goose/src/acp](https://github.com/aaif-goose/goose/tree/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/acp) | HTTP/WebSocket、health/status、token auth、CORS |
| Desktop | [ui/desktop](https://github.com/aaif-goose/goose/tree/3810898a7447ec3299be72e223d3570a7aabf0ab/ui/desktop) | bundled server、status readiness、reconnect、TLS pinning |
| Config/secrets | [config/base.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose/src/config/base.rs) | keyring、atomic write、0600 fallback |
| Update/release | [update.rs](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/crates/goose-cli/src/commands/update.rs)、[release.yml](https://github.com/aaif-goose/goose/blob/3810898a7447ec3299be72e223d3570a7aabf0ab/.github/workflows/release.yml) | Sigstore/SLSA provenance、archive traversal、跨平台发布 |

## 核心架构思想

~~~text
Provider
  -> Agent state machine
  -> MCP extension / permission / session
  -> ACP server
  -> CLI / Desktop / external client
~~~

1. Operation 计算结果和 Effect 持久化分离。
2. 每个 operation 可以取消、yield 到 approval、等待 tool result、恢复执行。
3. Conversation 是多投影状态：LLM input、用户 UI、审计、telemetry、恢复和 compaction。
4. Extension 是统一 tool virtualization layer，屏蔽 stdio、HTTP、builtin、frontend 和 inline Python 差异。
5. Permission 是 agent pipeline 的 operation，不是 UI 外挂回调。
6. SQLite 保存 message、tool request/response、usage、approval 和 session 状态。
7. ACP 是后端与 UI 的稳定边界，MCP 是 agent 与工具的稳定边界。
8. keyring、atomic config、structured logging、OTel 和 provenance 一起构成产品化基础。

## 对 DSHPilot 最有价值的部分

- 为 DSHPilot Control Plane 定义可取消、可暂停、可恢复的 operation。
- 将 approval、MCP reconnect、runtime update、remote device pairing 都建模为可观察状态，而不是临时 Promise。
- 用多投影 conversation/attachment 视角区分 Harness UI、remote UI、audit 和 token inspector。
- 统一 extension owner、tool identity、schema、timeout、cancellation、structured result。
- 采用 keychain-first secret storage；development/CI fallback 必须显式。
- 借鉴 shell 输出行数/字节数限制、完整输出落盘、timeout 和 process-tree cleanup。
- 借鉴 recipe/skill 的参数和路径安全校验。
- 借鉴 Sigstore/SLSA provenance、archive path traversal 检查和 release attestation。

## 不能照搬的部分

- 不要把 Goose 巨大的 Rust runtime、provider registry 和全部 computer-use 能力引入 DSHPilot。
- 不要复制 legacy agent path 与新 state machine 双轨。
- 不要把宿主 shell/file tool 或 SmartApprove 当成真正 OS sandbox。
- 不要复制 keyring 不可用时自动写 secrets.yaml 的宽松语义。
- 不要在 Phase 1 引入全 provider、OAuth、OTel、computer use 和复杂 recipe。

## 对 DSHPilot 的具体改进

### Phase 1

- Supervisor 使用 Operation/Effect 思维：start、stop、restart、rollback 都要有明确状态和持久化结果。
- Runtime、Harness、Desktop App 三类 update 分开记录。
- 所有子进程都有 timeout、cancel、stdout/stderr 上限和 process-tree cleanup。
- 生产 Runtime 必须签名；本地 unsigned 只能开发模式。

### Phase 2

- MCP Manager 统一 extension owner、tool schema、allowlist、tool count、health、reconnect。
- Document Provider 采用 parser/tool subprocess 隔离，限制时间、内存、输出和临时目录。
- Notification 和 approval 使用可恢复 operation，支持 app 重启后继续等待。

### Phase 3

- Remote API 采用 ACP-like typed boundary，但只暴露受限 DSHPilot API。
- PWA 断线时依赖 durable state/snapshot，不依赖临时 WebSocket。
- 任务/子 agent 限制 max turns、max depth、tool visibility 和 cancellation。

## 验收测试

- approval 中途杀进程，重启后仍能恢复相同 request。
- cancel 会同时终止 provider stream、MCP process 和 shell descendants。
- tool output 超过限制后返回 reference，不把完整输出塞进模型。
- parser 遇到 ZIP bomb、宏、路径穿越或超时会 fail closed。
- secret 不进入 state、日志、telemetry 和错误。
- update 包 checksum、签名、provenance、archive traversal 任一失败都不切换。
- 远程 device/token 失效后无法访问历史 session。
