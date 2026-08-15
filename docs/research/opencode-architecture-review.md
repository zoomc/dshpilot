# OpenCode 源码与架构研究

## 调查基线

- 仓库：[anomalyco/opencode](https://github.com/anomalyco/opencode)
- 分支：dev
- Commit：[4643e65ad6334de3e4e68dedc201d5fbb828c9fe](https://github.com/anomalyco/opencode/commit/4643e65ad6334de3e4e68dedc201d5fbb828c9fe)
- 当前版本：1.18.18

## 关键源码

| 领域 | 参考路径 | 可借鉴点 |
|---|---|---|
| Core | [packages/core](https://github.com/anomalyco/opencode/tree/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core) | session、runner、tool、event 的核心服务 |
| Protocol | [packages/protocol](https://github.com/anomalyco/opencode/tree/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/protocol) | endpoint/schema/error/cursor contract-first |
| Session | [packages/core/src/session.ts](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/session.ts) | create/list/history/prompt/resume/interrupt |
| Prompt admission | [session/input.ts](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/session/input.ts) | prompt_id 幂等、steer/queue、admission 与 execution 分离 |
| Events | [packages/core/src/event.ts](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/event.ts) | durable/live-only、aggregate sequence、projector、replay |
| Runner | [session/runner/llm.ts](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/session/runner/llm.ts) | 同一 Session 单执行器，wake 合并，interrupt cleanup |
| Tool | [packages/core/src/tool](https://github.com/anomalyco/opencode/tree/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/tool) | typed tool、snapshot、stale-call、bounded output |
| Permission | [packages/core/src/permission.ts](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/permission.ts) | allow/ask/deny、once/always/reject、resource rules |
| Provider route | [packages/llm/src/route/client.ts](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/llm/src/route/client.ts) | Protocol/Endpoint/Auth/Framing 四轴拆分 |
| Plugin | [packages/plugin](https://github.com/anomalyco/opencode/tree/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/plugin) | plugin host、tool/provider/auth/permission/slot |
| Workspace | [packages/core/src/location.ts](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/core/src/location.ts) | directory/workspace/project scoped runtime |
| Desktop | [packages/desktop](https://github.com/anomalyco/opencode/tree/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/packages/desktop) | sidecar、health check、IPC、签名、notarization、channels |
| Release | [publish.yml](https://github.com/anomalyco/opencode/blob/4643e65ad6334de3e4e68dedc201d5fbb828c9fe/.github/workflows/publish.yml) | 多平台构建、签名、发布和容器 |

## 核心架构思想

~~~text
HTTP prompt
  -> durable session_input
  -> PromptAdmitted event
  -> execution.wake()
  -> one Session runner
  -> provider/tool turn
  -> durable event + live delta
  -> projector / SSE / TUI / SDK
~~~

1. Prompt 被接收和 Prompt 开始执行是两个状态。
2. Event log 是事实来源，SQLite projection 是查询模型；不是把 UI state 当事实。
3. live delta 与 durable completion boundary 分开，减少写入压力并支持 replay。
4. 同一个 Session 只有一个 active drain，不同 Session 可以并发。
5. Tool 在一次 provider turn 开始时 materialize 成快照；工具变化后旧 call 不能误调用新工具。
6. 工具可见性和执行授权分离。
7. Provider 的协议、endpoint、auth、stream framing 分离。
8. API schema、server handler、core service、SDK/TUI 分层。

## 对 DSHPilot 最有价值的部分

### 1. 为 Desktop Control Plane 定义 durable events

DSHPilot 不应复制 Harness Session 数据库，但可以对 Desktop 自己负责的事实建立事件：

- runtime_started / ready / failed
- harness_restarted
- runtime_promoted / rolled_back
- device_paired / revoked
- mcp_config_changed
- document_added / removed
- notification_emitted

这些事件用于远程同步、审计、回放和测试，不取代 Harness 自己的 session facts。

### 2. 采用 prompt admission 思维

远程请求必须先 durable admission，再决定是否唤醒 Harness；重试使用 prompt_id 幂等，避免网络超时导致重复任务。

### 3. 单 Session 执行器

DSHPilot Task Center 后续必须保证同一 Harness session 不被多个 remote client 同时驱动；不同 session 可以并行。

### 4. Tool snapshot 与输出边界

MCP tools、document tools、remote tools 在一次 turn 中应有版本化快照；工具变更后旧调用返回 stale。大输出落到 managed artifact，事件只保存引用和摘要。

### 5. 真实 App Update 参考

OpenCode 的 sidecar health check、channel、签名、notarization 和多平台发布流程可用于补齐 DSHPilot 当前完全缺少的 App Update。

## 不能照搬的部分

- 不要复制完整 Effect/LayerNode 体系。
- 不要复制 V1/V2 双 Session、双 Storage、双 Server 架构。
- 不要第一阶段引入远端 workspace、owner claim、session warp。
- 不要早期开放几十种 plugin hook。
- 不要把完整 MCP OAuth、SSE fallback 和 provider heuristics 放入 Phase 1。
- 不要把 OpenCode 当前 V2 TODO 当成已经解决的问题。

## 对 DSHPilot 的具体改进

### Phase 1

- 增加 stable typed contract：HarnessStatus、RuntimePointer、DesktopEvent、Error、Cursor。
- Tauri/daemon 的 prompt-like 操作必须有 request ID 和幂等语义。
- readiness、runtime update、shutdown、restart 都产生可观察状态。
- 事件和 live stream 分开；远程恢复使用 cursor/snapshot。

### Phase 2

- MCP Manager 使用 tool snapshot、schema version、scope 和 stale-call 检查。
- Document tools 使用 bounded output/reference，不把完整文件注入上下文。
- Token Inspector 订阅 official usage events，而不是只在 UI 中计算数字。
- Client UI 只消费 protocol/events，不直接调用内部 Host state。

### Phase 3

- Remote API 采用 schema-first HTTP/SSE 或 WebSocket。
- 引入 connected、heartbeat、bounded queue、cursor、replay。
- 多 workspace 后置，先做一个 self-hosted host + 一个 workspace。

## 验收测试

- 相同 prompt_id 重试不产生重复 admission。
- provider/HTTP 超时后 admission 状态可查。
- live delta 丢失后可从 durable completion/snapshot 恢复。
- 同 Session 并发 prompt 被串行化。
- 工具 schema 变化后 stale call 不执行。
- 超大工具结果转成 artifact reference。
- malformed cursor、unknown session、unknown request 返回稳定 typed error。
