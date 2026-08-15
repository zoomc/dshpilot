# DSHPilot 最终架构改进与开发计划

## 文档目的

本文将四个高人气 Agent 项目的源码研究结果，与 DSHPilot 原始 Desktop 计划、当前仓库实现和未完成项合并，形成一份可执行的最终改进计划。

本文不是对 DeepSeek Harness 核心的重写方案。DSHPilot 的边界仍然是：

~~~text
官方 DeepSeek Harness + 官方 Web UI
        +
Tauri Desktop Host
        +
DSHPilot 独立 Host/Client Plugin
        +
受限的本地控制平面与 Remote PWA
~~~

所有来自 Paseo、OpenCode、Qwen Code、Goose 的设计，只吸收架构思想，不复制它们的 Agent Loop、Session、Tool Registry 或 UI。

## 研究基线

| 项目 | 当前研究 ref | 最重要的参考方向 |
|---|---|---|
| Paseo | [main 4748aad](https://github.com/getpaseo/paseo/commit/4748aad103bf3c4d4f23dacef37616450e490f4a) | self-hosted daemon、设备配对、断线恢复、relay/E2EE |
| OpenCode | [dev 4643e65](https://github.com/anomalyco/opencode/commit/4643e65ad6334de3e4e68dedc201d5fbb828c9fe) | durable admission、event/projector、session runner、typed API |
| Qwen Code | [main c396fe3](https://github.com/QwenLM/qwen-code/commit/c396fe3d12db4ee0683209578d9fce2b3a96b94f) | event-first、ToolRegistry、trust、sandbox、config provenance |
| Goose | [main 3810898](https://github.com/aaif-goose/goose/commit/3810898a7447ec3299be72e223d3570a7aabf0ab) | operation/effect、可恢复 approval、MCP extension、keyring、provenance |
| DeepSeek Harness | 当前 pinned runtime | 官方 Web UI、Session、Agent、MCP、Permission、Attachment seam |

四份单独研究记录：

- [Paseo 研究](/Volumes/ExSSD/Projects/dshpilot/docs/research/paseo-architecture-review.md)
- [OpenCode 研究](/Volumes/ExSSD/Projects/dshpilot/docs/research/opencode-architecture-review.md)
- [Qwen Code 研究](/Volumes/ExSSD/Projects/dshpilot/docs/research/qwen-code-architecture-review.md)
- [Goose 研究](/Volumes/ExSSD/Projects/dshpilot/docs/research/goose-architecture-review.md)

## 当前 DSHPilot 的真实状态（实现快照）

当前仓库已经具备：

- Tauri 2 Desktop shell 基础。
- 官方 Harness pinned submodule。
- bundled Node Runtime 构建。
- localhost Harness readiness smoke。
- SupervisorCore、Runtime manifest、SHA-256/Ed25519 验证基础。
- Upstream Guardian workflow 基础。
- MCP 配置/导入 Host 数据层。
- Token usage parser/estimate。
- Document content-addressed storage 和安全限制。
- Native notification 基础命令。
- Linux、macOS arm64、Windows x64 CI build/smoke。
- Tauri Supervisor 的状态、健康检查、进程树退出、tray、single-instance、deep-link 和手动 retry。
- signed immutable Runtime install/rollback，以及启动页上的独立 App/Runtime update 入口。
- Phase 2 Host/Client plugin routes and UI、official MCP patch composition、token estimate、content-addressed document provider 和 native notification bridge。
- Phase 3 typed control contracts、self-hosted daemon、官方 Harness `apiProxy` adapter、TLS/loopback guard、pairing、device scope、refresh rotation、SSE replay、PWA、artifact/Git/resource/lineage projections。
- Phase 3 direct HTTP/SSE remote transport and authenticated opaque WebSocket relay transport；relay 只验证 bearer/device access 和握手签名，不读取业务密文。
- Guardian 的 packaged Runtime boot、插件 loading、Web health 和失败后 workflow job failure propagation。

以下项目是 release/跨平台环境中的验收项，仍必须在对应 CI 或真实签名环境中完成：

1. 真实 release signing secrets 和 Windows/macOS 干净机器安装验收。
2. PDF 专用 parser、Office 深度内容 parser 和恶意文档 fuzz/timeout 矩阵。
3. OS Keychain/Harness Credentials 对所有第三方 secret provider 的真实端到端验收。
4. 真实 Harness approval/question 交互、MCP server 和 provider fixture 的跨平台长时运行验收。

## 一、四个项目共同验证的架构结论

### 1. 控制平面优先，而不是 UI 优先

Paseo 的核心是 daemon，OpenCode 的核心是 server/protocol，Qwen Code 的核心是 core/event/daemon，Goose 的核心是 ACP/MCP 边界。

DSHPilot 应从“直接由 Tauri 启动一个 Web URL”升级为：

~~~text
Tauri OS Shell
    |
    | local control protocol
    v
DSHPilot Control Plane
    |
    +-- Runtime Supervisor
    +-- official dsh web
    +-- MCP/document/notification adapters
    +-- local state and audit
    +-- restricted remote API
~~~

Tauri 仍只负责 OS、窗口、托盘、进程、Keychain、更新和原生能力；Control Plane 负责状态、协议、事件、适配器和远程边界；Harness 业务仍由官方实现。

### 2. Durable state、live stream 和 projection 必须分离

采用三层：

~~~text
Durable facts
    -> Projection / snapshot
    -> live event stream
~~~

DSHPilot 只为自己负责的事实持久化：

- Runtime lifecycle
- Harness readiness
- Desktop update
- MCP configuration
- Document manifest
- Device/pairing
- Remote task projection
- Notification delivery

不建立第二套 Harness Session/Agent/Tool 事实数据库。Harness 的 Session、Agent、Job、Goal 和 Tool 状态仍以官方 API/RPC 为准。

### 3. Prompt admission 不等于执行

所有来自 Desktop、PWA、CLI 的控制请求必须先经过：

~~~text
validate
-> authenticate
-> authorize
-> durable admission
-> execute or queue
-> event/result
~~~

请求必须有 requestId/promptId，重试幂等；HTTP 超时不能自动意味着任务没有接收。

### 4. Event-first

统一事件至少包含：

~~~text
server.connected
runtime.starting
runtime.ready
runtime.failed
runtime.restarting
harness.ready
harness.exit
permission.requested
permission.resolved
mcp.changed
document.changed
task.updated
notification.emitted
device.paired
device.revoked
~~~

高频文本 delta 可以 live-only；完整结束、错误、审批和状态切换必须有 durable boundary。

### 5. Tool visibility 和 execution authorization 分离

工具是否暴露给模型、是否允许被执行、是否需要用户确认，必须是三个不同判断：

~~~text
materialization
    -> permission policy
        -> approval
            -> execution
~~~

这条规则适用于 MCP、Document Tool、Remote Tool、Workspace Tool 和未来 Subagent Tool。

### 6. 不复制官方 Harness 核心

四个项目都说明了独立 Agent Runtime 的复杂度非常高。DSHPilot 不实现：

- Agent Loop
- Session store
- Tool Registry
- LLM provider core
- Permission core
- Official Web UI
- MCP protocol backend

DSHPilot 只实现官方 seam 外的 Desktop/Control Plane/Remote 产品层。

## 二、目标架构

### 2.1 目标模块边界

~~~text
apps/
  desktop/
  remote-pwa/                         # Phase 3

packages/
  control-contracts/                  # typed control/event/error schemas
  desktop-host/                       # Runtime, Supervisor, update, local state
  dsh-plugin-desktop/                 # Host plugin
  dsh-client-desktop/                 # minimal client seam
  dsh-plugin-mcp-manager/             # Phase 2
  dsh-client-mcp-manager/             # Phase 2
  dsh-plugin-context-inspector/       # Phase 2
  dsh-client-context-inspector/       # Phase 2
  dsh-plugin-documents/               # Phase 2
  dsh-client-documents/               # Phase 2
  remote-daemon/                       # Phase 3 self-hosted control plane
  remote-client/                       # Phase 3 protocol client

scripts/
  guardian/
  runtime/
  smoke/
  release/

vendor/
  deepseek-harness/
~~~

如果 upstream 已经提供某个功能，先标记为 SKIP_UPSTREAM_IMPLEMENTED，只实现必要的 Desktop management adapter。

### 2.2 Control Plane 的最小接口

第一版不需要完整 ACP，也不代理所有 Harness RPC。先定义 DSHPilot 自己的 typed contract：

~~~text
ServerInfo
HarnessStatus
RuntimeStatus
RuntimeManifest
DesktopEvent
RequestError
Cursor
Device
PermissionProjection
TaskProjection
~~~

接口层：

~~~text
GET  /health
GET  /server-info
GET  /runtime
GET  /events?after=
GET  /sessions
GET  /sessions/:id/snapshot
GET  /sessions/:id/events?after=
POST /sessions/:id/prompts
POST /sessions/:id/interrupt
GET  /tasks
GET  /permissions
POST /permissions/:id/reply
~~~

第一版支持 HTTP + SSE；需要双向控制和低延迟时再增加 WebSocket。

### 2.3 State ownership

| 状态 | 事实来源 |
|---|---|
| Harness Session/Agent/Tool/Skill/Permission | 官方 Harness |
| Runtime current/previous | DSHPilot Runtime manager |
| Harness process/readiness | DSHPilot Supervisor |
| MCP configuration overlay | DSHPilot MCP Manager + official MCP client |
| Document manifest/storage | DSHPilot Document Provider |
| Task Center | 官方 Session/Job/Goal/Agent 的 projection |
| Device/pairing/token | DSHPilot Remote Control Plane |
| App update | Tauri updater/release metadata |

## 三、Phase 1：完成稳定 Desktop Shell

Phase 1 的目标仍然是：无需用户安装 Node/pnpm/dsh，稳定运行官方 Harness Web UI，并拥有可验证的 Runtime/App 更新与回滚。

### P1-01：Control Contracts

新增 typed contract：

- Runtime lifecycle
- Harness lifecycle
- Supervisor status
- requestId/correlationId
- error class
- event sequence/cursor
- update transaction

验收：

- 所有事件可序列化和版本化。
- unknown event version 可安全降级。
- 同一 request 重试不会重复执行。

### P1-02：生产 Supervisor

补齐当前 Tauri Supervisor：

- stdout/stderr capture。
- readiness log parse + HTTP health check。
- 127.0.0.1 强制绑定。
- SIGTERM/Windows graceful close strategy。
- timeout 后 process-tree kill。
- unexpected exit 自动 restart。
- 指数退避上限 30 秒。
- failed 状态持久化。
- tray 显示真实状态。
- 用户手动 retry。
- app exit 先停止 Harness。
- deep-link 事件接收和路由。

建议状态：

~~~text
idle
starting
ready
stopping
stopped
restarting
failed
~~~

验收：

- 端口冲突、readiness timeout、子进程异常退出都产生明确错误。
- failed 状态不会无限自动重试。
- graceful stop 后不会误触发 restart。
- 真实 HTTP health check 失败时不能导航 WebView。

### P1-03：Runtime bundle 和 update transaction

完成完整事务：

~~~text
discover tested manifest
-> download to staging
-> stream + size limit
-> SHA-256
-> Ed25519 signature
-> archive path validation
-> extract staging
-> local runtime smoke
-> atomic install versions/runtime-id
-> promote current
-> restart Harness
-> health check
-> rollback previous on failure
~~~

要求：

- current 与 previous 永远保留。
- Runtime 不覆盖 DSH_HOME、credentials、sessions、settings、attachments、skills。
- runtimeVersion、upstream SHA、Node version、platform、arch 全部可追踪。
- 本地 unsigned 只允许 development profile。
- Release runtime 必须签名并保存 provenance。

借鉴 Goose 的 Sigstore/SLSA 和 archive traversal 检查，借鉴 OpenCode/Paseo 的 channel/version/health 设计。

验收：

- checksum 错误不切换。
- signature 错误不切换。
- archive path traversal 不解压。
- interrupted download 不损坏 current。
- runtime smoke 失败自动 rollback。
- rollback 后 DSH_HOME 完整保留。

### P1-04：Desktop App Update

实现 Tauri 官方 updater：

- GitHub Release。
- stable/beta channel。
- Windows x64。
- macOS arm64。
- 签名和公钥 pinning。
- 下载到 update staging。
- app update 与 runtime update 分离。
- 更新失败不影响 Harness data。

验收：

- 旧 App 可升级到新 App。
- App 更新失败仍能启动旧 App。
- App update 不替换 Runtime current。
- App release artifact 可在干净机器安装。

### P1-05：Upstream Guardian 完整化

每日流程：

~~~text
read tested SHA
-> fetch upstream candidate
-> build/typecheck upstream
-> build DSHPilot
-> unit/integration
-> real dsh web
-> HTTP readiness
-> Web HTML/RPC/session/settings smoke
-> Host/Client plugin loading
-> packaged Desktop smoke
-> runtime bundle
-> PASS/FAIL classification
~~~

需要补充：

- Tauri packaged build。
- 从 packaged resource 启动 Runtime。
- session list/settings/model/permission/MCP composition smoke。
- keyless fixture/provider stub。
- Guardian 自动更新 CHANGELOG。
- 失败 Issue 去重和更新，而不是每次新建。
- candidate PR 只修改 DSHPilot adapter/plugin/profile/manifest。
- stable SHA、Runtime Release 和 current pointer 解耦。

### P1-06：真实 Desktop 测试

必须增加：

- 安装后首次启动。
- 二次启动。
- single instance。
- tray 显示状态。
- graceful close。
- crash restart。
- failed/manual retry。
- data persistence。
- packaged runtime boot。
- Windows x64。
- macOS arm64。

### P1-07：Phase 1 完成门槛

以下全部通过才进入 Phase 2：

- Windows x64 安装器可安装和启动。
- macOS arm64 安装包可安装和启动。
- 无需用户安装 Node、pnpm 或 dsh。
- 官方 Web UI 可用。
- Harness 仅监听 localhost。
- current/previous Runtime 可升级和回滚。
- App Update 独立工作。
- Guardian 至少成功运行一次 candidate PASS 和一次故障 FAIL。
- CI 可从干净环境重现。
- 所有失败注入测试通过。

## 四、Phase 2：完成实际 Desktop 增强能力

Phase 2 先完成 UI/Control Plane 闭环，不再停留在 Host foundation。

### P2-01：Plugin packaging

创建真正的独立包：

- dsh-plugin-mcp-manager
- dsh-client-mcp-manager
- dsh-plugin-context-inspector
- dsh-client-context-inspector
- dsh-plugin-documents
- dsh-client-documents

每个插件必须：

- 使用官方 Client Plugin/Host Plugin seam。
- 使用 Cordis effect/disposer。
- 不 query DOM。
- 不 monkey patch React。
- 只依赖 typed service/event。
- 能被动态装载和卸载。

### P2-02：MCP Configuration Center

复用官方 @deepseek-ai/dsh-mcp-client，只实现管理层：

- server list。
- add/edit/delete。
- enable/disable。
- restart/reconnect。
- connection status。
- tools count。
- stdio command/args/env/cwd。
- streamable-http URL/headers/timeout。
- allowlist。
- server scope。
- source/provenance。
- error history。

安全要求：

- token、password、authorization 永不写普通日志。
- production secret 只能进 OS Keychain 或 Harness Credentials reference。
- env reference 与 literal value 明确区分。
- project MCP config 默认需要 workspace trust/approval。
- tool list 变化时更新 schema version 和 tool snapshot。

验收：

- 两个 MCP server 同名 tool 不冲突。
- server 失败不拖垮其他 server。
- reconnect 有退避和上限。
- tool-list-changed 后旧 snapshot 不执行 stale call。
- App 重启后配置和状态可恢复。

### P2-03：MCP Import

第一版支持最成熟的 2–3 种 JSON：

- Claude Desktop/Claude Code。
- Cursor。
- Generic mcpServers/servers。

流程：

~~~text
choose file
-> parse
-> normalize
-> preview
-> diff
-> secret scan
-> user confirm
-> atomic save
~~~

不支持：

- 自动覆盖。
- 明文 secret 显示。
- 未确认直接启动。
- 未信任 workspace 的 project config 自动生效。

### P2-04：Context/Token Inspector

作为 composer dock Client Plugin：

- 一行轻量状态。
- current model。
- context window。
- input/output/cache usage。
- system prompt estimate。
- tools/MCP schema estimate。
- skills estimate。
- conversation/tool result estimate。
- compaction 状态。
- official/estimate 标记。

原则：

- 优先使用 Harness/Provider official usage。
- 无法精确计算时必须显示 estimate。
- 不修改 Agent Loop、官方 composer 或官方 token accounting。

### P2-05：Document Attachments

实现完整 Provider/Parser/Tool 分层：

~~~text
Attachment
  -> Document Provider Registry
  -> Parser
  -> Manifest
  -> Document Tool
  -> Skill/Agent 按需调用
~~~

第一批：

- PDF
- DOCX
- XLSX
- PPTX
- CSV
- TXT
- MD
- JSON
- YAML
- XML

最小工具：

- document_inspect
- document_read
- document_search
- spreadsheet_sheet_info
- spreadsheet_read_range
- presentation_slide

Manifest 至少包含：

- 文件名、类型、大小、digest。
- PDF 页数。
- Workbook sheet、行列、公式摘要。
- Presentation slide 数。
- 文本编码和行数。
- parser/version。
- limits 和 extraction status。

安全：

- size/page/row/decompressed limits。
- ZIP bomb。
- path traversal。
- symlink escape。
- parser subprocess timeout。
- parser crash isolation。
- temp directory cleanup。
- 不执行宏、脚本、嵌入程序。
- extraction output bounded。
- 正文按需读取，不默认注入完整 context。

### P2-06：Native Notifications

将 Harness/Control Plane 事件映射为四类通知：

- task completed
- task failed
- waiting approval
- waiting user question

要求：

- event id 去重。
- notification policy 可配置。
- app 重启后 pending approval/question 不丢。
- 不在通知正文泄漏 secret、完整 prompt 或敏感文件内容。

### P2-07：Skills 与 Memory 的谨慎吸收

只有 upstream 没有成熟实现时才补：

- user/project scope。
- SKILL.md frontmatter。
- 支持文件和路径安全。
- read-only discovery。
- memory write 默认需要 approval。
- secret scanner。
- prompt 注入边界。

不要复制 Qwen 的完整 memory dream/team 功能，也不要建立与 Harness Skill 的第二套事实。

### P2-08：Phase 2 完成门槛

- MCP 管理 UI 可用。
- MCP import preview/diff/confirm 可用。
- secret 不出现在日志、state dump 和通知。
- Token Inspector 可显示 official/estimate。
- PDF/DOCX/XLSX/PPTX/CSV 至少完成 inspect/read 基础流程。
- parser 超时和恶意文档测试通过。
- 四类通知由真实事件触发。
- Windows/macOS UI/Host/Runtime 测试通过。
- Upstream Guardian 仍然通过。

## 五、Phase 3：Remote PWA 与 Desktop 差异化能力

Phase 3 在 Phase 1/2 全部通过后开始，且每次开始前重新检查 Harness upstream。

### P3-01：Self-hosted DSHPilot Daemon

目标：用户在自己的工作站、服务器或 Docker 中运行 daemon，数据和 Runtime 留在用户控制的机器上。

部署模式：

1. Tauri Desktop 内置并管理 daemon。
2. CLI/headless 模式直接运行 daemon。
3. Docker 模式挂载 DSH_HOME、desktop state、Runtime 和 logs。
4. PWA 只连接 daemon，不直接连接 Harness Runtime。

Daemon 负责：

- Runtime Supervisor。
- Harness lifecycle。
- restricted API。
- session/task projection。
- device/pairing。
- event cursor/replay。
- notification routing。
- artifact access control。

Tauri 负责：

- OS process bootstrap。
- tray/window。
- Keychain。
- app update。
- local permission prompts。

### P3-02：Remote security model

默认：

- local-only。
- 127.0.0.1。
- remote mode 必须用户主动开启。
- 不默认公网监听。

设备配对：

1. daemon 生成稳定 server identity 和 keypair。
2. 用户在 Desktop 中生成短时 pairing QR/URL。
3. offer 包含 server ID、公钥、过期时间、一次性 nonce。
4. PWA 完成配对后获得独立 device ID。
5. 每台设备有独立 refresh/access token。
6. 支持设备列表、撤销、token rotation、全部注销。

权限层次：

~~~text
transport encryption
  -> device authentication
  -> token validation
  -> device scope
  -> workspace scope
  -> session/task permission
  -> Harness approval
~~~

direct remote：

- LAN、Tailscale、WireGuard、用户自有 VPN。
- TLS 优先。
- server identity pinning。
- origin/CORS allowlist。
- rate limit。
- constant-time token compare。

relay remote：

- relay 只做盲路由。
- 业务 payload 端到端加密。
- relay 不保存 session 内容。
- relay channel 有过期和重放保护。
- relay 是可选部署组件，不是强依赖。

### P3-03：Remote API

第一版只暴露：

~~~text
server_info
runtime_status
session_list
session_snapshot
session_events
prompt_admission
interrupt
permission_list
permission_reply
task_list
artifact_metadata
artifact_download
device_list
device_revoke
~~~

禁止：

- 完整 Harness RPC proxy。
- 任意执行 Rust/Tauri command。
- PWA 直接读取 DSH_HOME。
- PWA 直接读取 Runtime secrets。
- 未授权 workspace 文件访问。
- remote MCP server admin 默认开放。

### P3-04：PWA 和断线恢复

客户端必须支持：

- connected event。
- heartbeat。
- bounded queue。
- last-event-id。
- snapshot + event catch-up。
- gap detection。
- deduplication。
- reconnect backoff。
- offline read-only cache。
- pending approval 明确显示。

PWA 不保存 API keys、MCP secrets 或完整 Runtime credentials。

### P3-05：Task Center

Task Center 是投影，不是第二套 Agent 数据库。

来源：

- official Session。
- official Job。
- official Goal。
- official Agent state。
- DSHPilot Runtime/process state。

显示：

- task status。
- session/agent identity。
- parent/child lineage。
- current turn。
- waiting approval/question。
- runtime failure。
- artifacts。
- changed files。

### P3-06：Artifact Viewer

只读：

- text/markdown。
- JSON/YAML/XML。
- image preview。
- PDF page preview。
- office manifest/selected content。
- diff patch。

操作：

- Save As。
- Reveal in Finder/Explorer。
- Download through authorized artifact token。

不做完整 IDE，不让 Viewer 直接执行文件。

### P3-07：Git/Diff Presentation

实现：

- changed files。
- diff。
- branch。
- commit summary。
- working tree status。
- session/task associated change。

所有 Git 操作仍由 Harness tool/host policy 负责，UI 只呈现或调用受限 command。

### P3-08：Resource Attachments

统一 Provider seam：

- File。
- Folder。
- Git repository。
- GitHub PR/Issue。
- URL。

每个 Resource Provider 必须：

- manifest-first。
- source/provenance。
- size/timeout limits。
- authorization。
- cache policy。
- explicit refresh。

### P3-09：Session Fork Visualization

只显示：

- parent session。
- fork point。
- child lineage。
- current branch of conversation。

不改变官方 fork 语义，不复制 Session storage。

### P3-10：Monaco Editor

仅在：

- Artifact Viewer 稳定。
- Git/Diff 稳定。
- Resource Provider 稳定。
- Remote authorization 稳定。

之后评估。第一版只做 read-only viewer，不做完整 IDE。

## 六、跨项目吸收矩阵

| 能力 | Paseo | OpenCode | Qwen Code | Goose | DSHPilot 采用方式 |
|---|---|---|---|---|---|
| Local daemon | 核心 | server | daemon/ACP | ACP server | Phase 1.5/3，Tauri 管理 |
| Typed protocol | 核心 | 核心 | typed events | ACP | P1-01 |
| Durable event | timeline | EventV2 | replay | session effects | Desktop/remote facts |
| Session runner | AgentManager | one drain | AgentCore | state machine | 不复制，使用 Harness |
| Tool registry | catalog | snapshot | canonical registry | ExtensionManager | 只用于 DSHPilot additions |
| Permission | scopes | allow/ask/deny | trust+sandbox | action-required | adapter + official Harness |
| Config provenance | partial | location | source/trust | config layers | MCP/document/remote |
| Self-host remote | 强 | workspace | daemon/SDK | ACP | Paseo 优先借鉴 |
| Pairing/E2EE | relay | limited | daemon auth | TLS pinning | Phase 3 opt-in |
| MCP | adapter | multi-transport | pool/reconnect | extension manager | official dsh-mcp-client |
| Documents | timeline/artifacts | bounded output | memory/skills | attachment/projection | Provider + tools |
| Subagents | child agents | session controls | depth/identity | max turns | official Harness projection |
| Sandbox | host boundary | permission | Seatbelt/Docker | tools not sandbox | Tauri/host profile |
| Update | channel/rollout | signing/channels | installer | provenance | App + Runtime separate |
| Testing | vertical slice | protocol/E2E | security tests | replay/state machine | full fixture matrix |

## 七、优先级和开发顺序

### P0：立即补齐 Phase 1 阻塞项

1. production Supervisor state/health/retry。
2. App Updater。
3. Runtime update transaction wiring。
4. production signature/provenance。
5. packaged runtime boot smoke。
6. Guardian complete Desktop compatibility。
7. Keychain infrastructure。
8. install/launch/rollback E2E。

### P1：完成 Phase 2，而不是继续堆 Host foundation

1. Plugin package boundaries。
2. MCP UI/lifecycle/keychain/import。
3. Token Inspector UI/official usage integration。
4. Document parser/tool subprocess architecture。
5. Native notification event bridge。

### P2：为 Phase 3 建立控制平面

1. control-contracts。
2. local daemon。
3. HTTP/SSE protocol。
4. session/task projections。
5. snapshot/cursor/replay。

### P3：Remote self-hosting

1. local-only daemon。
2. LAN/VPN direct remote。
3. device pairing/revocation。
4. PWA。
5. relay/E2EE。
6. Task Center/artifacts/Git/Diff。

## 八、测试策略

### Unit

- contract schema/version。
- request idempotency。
- Supervisor transitions。
- readiness/health。
- manifest/signature/checksum。
- archive traversal。
- MCP normalization/diff。
- token source/estimate。
- document limits。
- notification deduplication。
- pairing token expiry。
- scope matching。

### Integration

- real dsh web boot。
- patch/plugin loading。
- MCP fixture server。
- document parser fixture。
- keychain fake。
- Runtime update fake server。
- Tauri command boundary。
- daemon HTTP/SSE。

### Failure injection

- port conflict。
- runtime process exit。
- readiness timeout。
- HTTP health failure。
- SIGTERM timeout。
- download interruption。
- checksum mismatch。
- signature mismatch。
- corrupt archive。
- archive traversal。
- current runtime corruption。
- stale event cursor。
- duplicate promptId。
- expired/revoked device token。
- relay disconnect。
- parser crash/timeout。

### Cross-platform

Linux：

- lint
- typecheck
- unit
- protocol/integration
- upstream Guardian
- Web smoke

Windows x64：

- clean install
- Tauri NSIS
- packaged Runtime boot
- tray/single instance
- Runtime update rollback
- native notification

macOS arm64：

- clean install
- app bundle/signing/notarization path
- packaged Runtime boot
- Keychain
- deep link
- tray/menu
- Runtime update rollback

### Remote security

- local-only default。
- remote opt-in。
- wrong origin。
- wrong token。
- expired pairing。
- reused pairing。
- device revoked。
- workspace out-of-scope。
- session out-of-scope。
- replayed event。
- relay payload confidentiality。
- rate limit。
- no secret in PWA/network logs。

## 九、版本、发布和迁移策略

版本始终分层：

~~~text
Desktop App
Harness Runtime
Extension Pack
Remote Protocol
~~~

建议：

- Desktop App：semantic version。
- Harness Runtime：upstream SHA/version/platform/arch。
- Extension Pack：独立 compatibility version。
- Remote Protocol：major/minor schema version。

发布通道：

- tested
- beta
- latest

默认只使用 tested。任何 upstream candidate 未通过完整 compatibility pipeline，不得更新 stable。

Release 必须包含：

- Windows x64 installer。
- macOS arm64 installer。
- Runtime bundle。
- Runtime manifest。
- SHA-256。
- Ed25519 signature。
- provenance/attestation。
- changelog。
- compatibility report。

## 十、最终验收标准

### Phase 1

- Desktop 安装、启动、退出、单实例、托盘、崩溃恢复可验证。
- 无需用户安装 Node/pnpm/dsh。
- 官方 Web UI 可用且未 Fork。
- Harness 只监听 localhost。
- Runtime current/previous 可升级、健康检查、回滚。
- App Update 与 Runtime Update 独立。
- Guardian 可检测、构建、测试、发布 candidate。
- CI 和干净环境可复现。

### Phase 2

- MCP 管理 UI 有真实 UI、状态、重连、导入和 secret storage。
- Token Inspector 有 composer dock 和 official/estimate 标记。
- Documents 有 parser/provider/tool/安全隔离/按需读取。
- Native Notifications 由真实 Harness/control events 触发。
- 所有扩展通过独立 Host/Client Plugin。
- Windows/macOS 和 Guardian 全部通过。

### Phase 3

- self-hosted daemon 可独立运行。
- Desktop、PWA、CLI 使用同一 typed protocol。
- 默认 local-only，remote opt-in。
- direct LAN/VPN 可用。
- pairing、device revoke、token rotation、scope 生效。
- relay 可选且不能读取明文。
- PWA 断线可 snapshot + replay 恢复。
- Task Center、Artifact、Git/Diff 只做官方状态的 projection。
- 不代理完整 Harness RPC，不建立第二套 Session/Agent 事实库。

## 十一、明确不做的事情

- 不 Fork DeepSeek Harness。
- 不复制官方 Web UI。
- 不重写 MCP protocol/backend。
- 不复制 OpenCode、Qwen Code 或 Goose 的完整 Agent Runtime。
- 不在 Phase 1 做 Remote PWA。
- 不把 pairing 当授权。
- 不把 approval 当 sandbox。
- 不将完整文件正文默认塞入 context。
- 不让 CI 自动修改 upstream 核心。
- 不在 remote API 暴露完整 Harness RPC。
- 不创建第二套 Session/Agent/Job/Goal 数据库。

## 结论

DSHPilot 最终应成为：

~~~text
官方 Harness 能力底座
  + Tauri OS shell
  + 可恢复的 local control plane
  + plugin-first desktop management
  + tested Runtime/App update system
  + Paseo-inspired self-hosted remote daemon
  + restricted Remote PWA
~~~

最优先的不是增加更多 Agent 功能，而是完成当前 Phase 1 的生产更新/回滚/安装闭环，再把 Phase 2 从 Host foundation 推进到真实 Plugin UI 和 parser/tool，最后以 Paseo 的 self-hosted daemon 思路实现受限、可撤销、可审计的 Remote PWA。
