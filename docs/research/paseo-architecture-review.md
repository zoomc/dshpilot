# Paseo 源码与架构研究

## 调查基线

- 仓库：[getpaseo/paseo](https://github.com/getpaseo/paseo)
- 分支：main
- Commit：[4748aad103bf3c4d4f23dacef37616450e490f4a](https://github.com/getpaseo/paseo/commit/4748aad103bf3c4d4f23dacef37616450e490f4a)
- 定位：在本机编排多个 coding agent，并从桌面、移动端、Web 和 CLI 访问同一个 self-hosted daemon。

## 关键源码

| 领域 | 参考路径 | 可借鉴点 |
|---|---|---|
| 架构边界 | [docs/architecture.md](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/docs/architecture.md) | daemon、client、protocol、relay、desktop 分层 |
| Daemon 组装 | [packages/server/src/server/bootstrap.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/server/src/server/bootstrap.ts) | 本地控制平面统一装配 AgentManager、Storage、MCP、relay |
| Wire protocol | [packages/protocol/src/messages.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/protocol/src/messages.ts) | Zod schema、requestId、rpc_error、capability negotiation |
| WebSocket session | [packages/server/src/server/websocket-server.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/server/src/server/websocket-server.ts) | hello、客户端能力、连接租约、断线恢复 |
| Agent lifecycle | [agent-manager.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/server/src/server/agent/agent-manager.ts) | runtime 和 durable agent identity 分离 |
| Agent storage | [agent-storage.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/server/src/server/agent/agent-storage.ts) | Zod 校验、原子写入、串行化 |
| Tool catalog | [paseo-tools.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/server/src/server/agent/tools/paseo-tools.ts) | transport-neutral tools，再适配 API、CLI、MCP |
| Desktop daemon | [daemon-manager.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/desktop/src/daemon/daemon-manager.ts) | desktop 管理受管 daemon，轮询 ready/status |
| Supervisor | [scripts/supervisor.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/server/scripts/supervisor.ts) | 心跳、崩溃重启、进程树终止 |
| Pairing | [pairing-offer.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/server/src/server/pairing-offer.ts) | serverId、公钥、relay endpoint 的配对 offer |
| Relay E2EE | [encrypted-channel.ts](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/packages/relay/src/encrypted-channel.ts) | relay 只路由，payload 端到端加密 |
| 测试 | [docs/testing.md](https://github.com/getpaseo/paseo/blob/4748aad103bf3c4d4f23dacef37616450e490f4a/docs/testing.md) | unit、真实 daemon E2E、provider E2E、desktop E2E 分层 |

## 核心架构思想

~~~text
Client
  -> WebSocket / direct TCP / relay
  -> logical session
  -> AgentManager
  -> provider agent
  -> timeline / durable agent record
~~~

1. Daemon 是本地控制平面，客户端只观察、提交命令和呈现状态。
2. logical client/session 与 physical socket 分离，同一 client 可多窗口连接，断线后可以恢复。
3. Agent identity、workspace、timeline、labels 持久化；provider process、socket、pending request 属于 runtime。
4. Live stream 只负责低延迟，authoritative snapshot/timeline 负责断线 catch-up。
5. Agent lifecycle 是显式状态机；取消只有在 provider 确认 interrupt 或 terminal event 后才算结束。
6. Tool catalog 先独立于传输层，再适配 WebSocket、CLI、MCP。
7. relay 负责路由，不负责读取业务内容；pairing、加密、认证、RPC scope、workspace authorization 是不同层。

## 对 DSHPilot 最有价值的部分

### Self-hosted remote 方案

Paseo 最值得借鉴的不是移动端 UI，而是 self-hosted daemon 的部署模型：

~~~text
DSHPilot Desktop / PWA / CLI
        |
        | typed protocol
        v
DSHPilot Daemon on user's workstation
        |
        +-- official dsh web
        +-- Runtime Supervisor
        +-- DSH_HOME
        +-- local MCP / documents
        +-- session/task projection
~~~

建议 DSHPilot Phase 3 采用以下连接顺序：

1. 默认 local-only，保持 127.0.0.1。
2. 用户主动开启 remote mode 后，优先支持同一 LAN、Tailscale、WireGuard 或用户自有 VPN。
3. 需要跨网络时再启用 relay；relay 只做盲路由，内容仍由 daemon/client 端到端加密。
4. 配对使用短时、一次性、可撤销的 pairing offer；设备获得独立 device ID、refresh token 和最小 scope。
5. pairing 不等于授权；每个 device 仍需要认证、scope、workspace 和 agent 权限检查。

建议的最小 remote API：

~~~text
GET  /health
GET  /server-info
POST /devices/pair/complete
GET  /devices
DELETE /devices/:id
GET  /sessions
GET  /sessions/:id/snapshot
GET  /sessions/:id/events?after=
POST /sessions/:id/prompts
POST /sessions/:id/interrupt
GET  /tasks
~~~

不要在 remote API 中暴露完整 Harness RPC；只暴露受限的 session、task、approval、artifact、status 投影和操作。

## 不能照搬的部分

- 不要一开始复制 Paseo 目前已经很大的 protocol。
- 不要把 JSON 文件存储当长期 session 数据库；应抽象 repository，后续使用 SQLite/WAL。
- 不要把 pairing 或 relay 当成完整权限系统。
- 不要默认允许第三方插件直接执行宿主代码。
- 不要在 Phase 1 引入 relay、E2EE、移动端和复杂远程 workspace。
- 不要复制 provider-native subagent；先由 DSHPilot 管理受限的 child task。

## 对 DSHPilot 的具体改进

### Phase 1

- 将 Tauri 直接启动 Harness 的逻辑逐步抽象成 local control plane。
- 为 Supervisor、Runtime、Harness readiness、Native events 定义 typed protocol。
- 把 durable identity 和 runtime process 分离。
- 增加 authoritative status/snapshot，不能只依赖 stdout。

### Phase 2

- MCP、documents、notifications 都先进入统一 tool/event adapter。
- 不让 Client Plugin 直接读 Rust 状态；通过 Host service 或 typed protocol。
- 为 MCP 状态、document manifest 和通知建立可回放事件。

### Phase 3

- 新增 self-hosted daemon 和 PWA client。
- 实现 direct LAN/VPN、pairing、device revocation、scope、token rotation。
- relay/E2EE 后置，且不代理全部 Harness RPC。

## 验收测试

- daemon 重启后 agent/session identity 不变。
- 同一 client 多连接不会重复执行 prompt。
- 断线后 snapshot + sequence catch-up 不丢事件、不重复投影。
- provider 未确认取消时，状态不能提前变成 stopped。
- pairing offer 过期、重复使用、撤销设备、错误 token 都拒绝。
- relay 无法读取明文业务 payload。
- remote API 访问 workspace 外资源和未授权 session 必须失败。
