# DSHPilot 项目交接文档

> 交接日期：2026-08-15（Asia/Shanghai）
>
> 项目根目录：/Volumes/ExSSD/Projects/dshpilot
>
> GitHub：https://github.com/zoomc/dshpilot
>
> 用途：供下一位 agent 直接接管当前工作树、修复遗留问题、重新验证、提交和发布。

## 0. 当前状态摘要

当前项目已完成 Phase 1、Phase 2、Phase 3 的主要代码主线，并通过过本地 TypeScript、Rust、Vitest、lint、build 和 Runtime smoke。可是当前版本还不能宣布 release-ready，原因是最新 review 发现了几个真实的阻塞问题。

最重要的结论：

- Client Plugin 产物可能不符合 DeepSeek Harness module loader 的实际格式，左下角更新按钮还没有经过真实 module loader/WebView 验证；
- Rust readiness probe 无法正确处理 chunked HTTP response，Windows/macOS CI 的安装后 readiness/health 曾失败；
- external dsh adoption 只判断 127.0.0.1:3080 返回 HTML，未验证 DSHPilot Plugin、health、PID identity 和 ownership；
- service registry 的 desktop 目录没有正确创建，写入失败被静默忽略；
- App update 没有可靠证明真正 relaunch；
- current Runtime 损坏时，更新/回滚可能无法从内置 Runtime 自举；
- Remote 的 questions、artifacts、resources、events 和按 ID 读取仍有 workspace 越权缺口；
- bounded read、relay buffer、DNS rebinding、PWA cursor/SSE 状态和 relay channel ownership 仍需修复；
- 当前工作区有未提交改动，远端仍停在 8a694ee；
- 本机安装的是外置盘上的 adhoc Debug App，不是签名生产安装包。

本文件已经把三个 review agent 的结果纳入。下一位 agent 不要把之前的“49 个测试全绿”误解为跨平台和安全验收全绿。

## 1. 前因后果

### 1.1 附件是约束，不等于用户全部请求

用户最初提供的附件：

/Users/mj/Desktop/deepseek-harness-desktop-development-plan-prompt(1).md

附件是项目初始化、架构边界、Phase 1/2/3 计划和验收约束。其核心要求：

- Tauri/Rust 负责 OS、窗口、托盘、进程、Runtime、Keychain、更新；
- 官方 DeepSeek Harness 继续负责 Web UI、Agent Loop、Session、MCP 和业务事实；
- DSHPilot 只能通过 Host/Client Plugin、profile、adapter、control plane 扩展；
- upstream 以 vendor/deepseek-harness submodule 物理隔离，不修改其源代码；
- Runtime 与 App 独立版本化；
- Runtime 要有 SHA-256、Ed25519、current/previous、原子切换、smoke 和 rollback；
- 建立 Upstream Guardian；
- Phase 1 完成 Desktop Shell、Supervisor、Runtime、CI、Guardian；
- Phase 2 完成 MCP、Token/Context、Document Attachment、Native Notification；
- Phase 3 完成 Remote PWA、Task Center、Artifact、Git/Diff、Resource、Session lineage；
- 不创建长期维护的 PLAN.md、ROADMAP.md、ARCHITECTURE.md。

这份交接文档是操作记录，不是把附件改成新的架构事实。

### 1.2 用户后来追加的执行要求

用户要求：

1. 继续并补齐 Phase 2；
2. 对比调查 Paseo、OpenCode、Qwen Code、Goose 源码；
3. 将研究写入 MD，并形成最终架构改进计划；
4. Phase 3 也完成；
5. 派 subagent review/test；
6. App 启动时检查 dsh，没有就启动；
7. 自动更新有更新时左下角显示按钮，点击时检查运行中的 session，确认后更新并重启；
8. GitHub README 中英双语、图标、About、排版、SEO 和 topics；
9. App 图标神似 DeepSeek，但具有 DSHPilot 自己的变化；
10. 在本机安装并运行。

## 2. 仓库、GitHub、版本和工具链

### 2.1 GitHub

~~~text
local:       /Volumes/ExSSD/Projects/dshpilot
branch:      main
remote:      git@github.com:zoomc/dshpilot.git
visibility:  public
owner:       zoomc
default:     main
~~~

GitHub description：

Bilingual Tauri desktop workstation and self-hosted remote control plane for DeepSeek Harness

当前 topics：

- deepseek-harness
- desktop-app
- rust
- tauri
- typescript
- dshpilot
- deepseek-harness-desktop
- dsh-plugin
- self-hosted-ai
- dshpilot-desktop
- remote-pwa

GitHub CLI 登录用户是 zoomc，已验证 repo/workflow 权限。Homepage 当前为空。README、LICENSE、图标的新版本尚未 push 到远端。

### 2.2 Git 提交历史

~~~text
8a694ee feat: complete phase 1-3 desktop and remote integration  <-- origin/main
bc42cc7 fix: close phase 1-3 integration gaps
d796704 feat: finish phase 1-3 integration
3b25121 feat: complete phase 1-3 desktop integration
6f56b12 docs: add architecture research and final improvement plan
~~~

当前工作区的改动没有提交，也没有 push。接手后必须先审查 git diff，再决定修复后一次提交还是分批提交。

### 2.3 Upstream

~~~text
submodule: vendor/deepseek-harness
repository: https://github.com/deepseek-ai/deepseek-harness
ref:        master
sha:        47f943859bef60e4160492346772ded9b24f765a
version:    0.1.0-rc.5
~~~

检查：

~~~sh
cd /Volumes/ExSSD/Projects/dshpilot
git submodule status
git -C vendor/deepseek-harness rev-parse HEAD
git -C vendor/deepseek-harness status --short
~~~

submodule 必须保持 clean。Upstream candidate 的兼容修复只能写在自有 adapter、plugin、profile 或 manifest。

### 2.4 工具链

- Node 目标 Runtime：22.19.0；
- pnpm：11.7.0；
- Rust/Cargo 已安装；
- Tauri CLI：@tauri-apps/cli 2.5.0；
- Tauri crate：2；
- TypeScript、Vite、Vitest；
- Remote PWA：React 19 + Vite 6；
- Relay：Node/TypeScript + ws；
- bundled Runtime 自带 Node，不要求用户安装 Node、pnpm 或 dsh。

## 3. 架构原则和边界

~~~text
Tauri/Rust
  ├─ OS、窗口、单实例、托盘、深链、通知、Keychain、App update
  ├─ bundled Node Runtime
  └─ Harness Supervisor：spawn/adopt/readiness/stop/restart/rollback

official dsh web + Harness
  ├─ Web UI、Agent Loop、Session、Composer
  ├─ MCP、Tool renderer、Attachment seam
  ├─ RPC、module loader、UI slots、HMR
  └─ DSHPilot additive Host/Client plugins

DSHPilot Control Plane
  ├─ typed contracts
  ├─ projection、pairing、device、workspace authorization
  ├─ direct HTTP/SSE
  └─ optional blind opaque relay

Remote PWA
  └─ projection + explicitly admitted actions；不是完整 RPC proxy
~~~

必须保持：

- 官方 Harness 是业务事实源；
- Tauri 负责系统和生命周期；
- Remote 不建立第二套 Session/Job/Goal 事实库；
- relay 不读取业务明文；
- Runtime 目录不保存 credentials、session、settings、attachments 或 skills；
- 不修改 vendor/deepseek-harness；
- 不用外部项目的完整 Agent Loop 替换 Harness。

### 3.1 Supervisor 状态机

计划状态机：

~~~text
idle → starting → ready → stopping → stopped → restarting → failed
~~~

额外状态 adopted-external 表示采用一个已经运行但不属于当前 DSHPilot ownership 的 loopback dsh。

Supervisor 必须：

- 启动时先检查 dsh；
- 只有通过 health、identity、PID、plugin marker 和 ownership 检查才能 adopt；
- 没有合格服务时用 bundled Runtime 启动官方 dsh web；
- 捕获 stdout/stderr；
- 正确处理 HTTP readiness，包括 Content-Length 和 chunked body；
- SIGTERM 优雅停止，超时强制终止；
- unexpected exit 自动重启，指数退避最大 30 秒；
- 连续失败进入 failed；
- 退出时只停止 owned child；
- 默认只绑定 127.0.0.1。

本轮曾修复 tray monitor deadlock：不能在持有 Supervisor mutex 时调用需要主线程的 tray API。后续必须保留“复制 snapshot、释放 mutex、再调用 tray API”的方式。start/ensure 的长锁和并发幂等仍需继续修。

### 3.2 Runtime

Runtime manifest 包含：

~~~text
schemaVersion
channel: tested
runtimeVersion
upstream.repository/ref/sha/version
node.version/platform/arch
artifact.url/size/sha256/signature
generatedAt
~~~

数据布局：

~~~text
app-data/
  runtime/
    versions/<runtime-id>/
    current.json
    previous.json
    staging/
  dsh-home/
  desktop/
  logs/
  update/
~~~

更新事务：

~~~text
download
→ SHA-256
→ Ed25519
→ extract staging
→ local runtime smoke
→ atomic current.json
→ restart Harness
→ health check
→ failure: restore previous
~~~

当前本机 manifest signature 是 UNSIGNED-LOCAL，不是正式发布签名。

## 4. Phase 1/2/3 实现状态

### 4.1 Phase 1：已实现与未完成

已有：

- Tauri 2 desktop shell；
- bundled Node Runtime；
- Supervisor、readiness、日志、重启、single-instance、tray；
- WebView 启动 ensure_harness；
- App/Runtime update 分离基础；
- current/previous/staging、hash、signature、smoke、rollback 基础；
- Runtime bundle；
- upstream Guardian；
- Linux、Windows x64、macOS arm64 CI job；
- Tauri CI resource overlays；
- README、CHANGELOG、MIT LICENSE、icon；
- macOS 本机 App bundle、安装、启动和 loopback readiness。

遗留：

- Windows/macOS CI 的安装后 health 曾失败；
- readiness probe 的 chunked HTTP 解析必须修；
- service registry 目录、atomic write、失败报告必须修；
- external dsh identity/plugin/health/ownership 必须严格验证；
- 默认 tauri build 可能不包含 Runtime resource；
- current Runtime 损坏时缺少 embedded bootstrap；
- App update relaunch 未被 E2E 证明；
- 生产签名和 release secrets 未完成；
- current 工作区未提交。

### 4.2 Phase 2：已实现与未完成

已有：

- MCP 配置读取、归一化、preview/diff/patch、启停/重连状态；
- 复用官方 @deepseek-ai/dsh-mcp-client；
- Token/Context projection 和 estimate；
- Document provider、bounded read、安全上限；
- native notification bridge；
- Client Plugin composer 和 sidebar 官方 slot registration；
- Runtime/App update action；
- running session 检查和提示；
- phase 2 tests 和 smoke。

遗留：

- 部分 MCP/import/document UI 还是 prompt/alert；
- 没有真实 WebView/browser slot interaction test；
- 真实 MCP/provider/approval/question 长时测试缺失；
- Keychain/credential reference production path 需审计；
- parser、大文件、archive/path traversal 压力测试不足；
- Client Plugin bundle 不能继续按普通 ESM 处理，见 review。

### 4.3 Phase 3：已实现与未完成

已有：

- typed control contracts；
- self-hosted remote-daemon；
- Harness apiProxy adapter；
- direct HTTP/SSE；
- optional blind opaque WebSocket relay；
- pairing、device registry、refresh rotation、token expiration；
- workspace IDs 和 device scope 基础；
- loopback/TLS boundary；
- URL SSRF 检查；
- relay handshake/peer/rate/payload/age/idle 限制；
- PWA QR pairing、scope、heartbeat、browser notification permission；
- Task/Job/Goal、Artifact、Git/Diff、Resource、lineage projection 基础。

遗留：

- questions/artifacts/resources/events list 未完整 workspace filter；
- artifact/resource/lineage get-by-id 未统一检查 owner workspace；
- permission_reply 缺少充分 owner context；
- bounded read 和 relay buffer 可能先读完整内容；
- DNS rebinding；
- PWA cursor/generation/SSE health；
- task completed/failed remote notification；
- relay channel ownership/hijack；
- standalone daemon 默认 device persistence；
- stale running job 的 interrupted 语义。

## 5. 源码研究记录

完整资料：

- docs/research/paseo-architecture-review.md
- docs/research/opencode-architecture-review.md
- docs/research/qwen-code-architecture-review.md
- docs/research/goose-architecture-review.md
- docs/DSHPilot-final-architecture-improvement-plan.md

研究快照：

~~~text
Cordis:        main 8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4
Paseo:         main 4748aad103bf3c4d4f23dacef37616450e490f4a
OpenCode:      dev 4643e65ad6334de3e4e68dedc201d5fbb828c9fe
Qwen Code:     main c396fe3d12db4ee0683209578d9fce2b3a96b94f
Goose:         main 3810898a7447ec3299be72e223d3570a7aabf0ab
~~~

### Cordis

Context、Service、typed events、Fiber、effect/disposer、Loader/HMR 是关键。DSHPilot 的每个 Plugin 注册、timer、process、event、SSE、WebSocket、watcher 都应该有 disposer，HMR/unload 不能留下副作用。

### Paseo

最重要的是 self-host daemon：

- daemon 是 source of truth；
- UI 是可断开、可重连的 projection；
- pairing 是短时、一次性、可撤销 capability；
- relay 只转发 opaque encrypted payload；
- heartbeat、lease、ownership、backpressure、断线恢复要显式建模；
- spawn/adopt/owned/foreign 要区分。

这直接影响 remote-daemon、pairing、device scope、relay 和 Desktop adoption。不要把远程做成 WebView 完整 RPC 镜像。

### OpenCode

借鉴 admission/execution 分离、单 session runner、durable/live event 分离、event cursor/replay/projector、typed protocol、update/session admission controller。后续 update、approval、pairing、MCP reconnect 都应逐渐从临时 Promise 变为可观察 operation。

### Qwen Code

借鉴 event-first、ToolRegistry、owner/source/schema/provenance、workspace trust、sandbox、路径边界、bounded streaming 和 tool output limits。MCP/Document Provider 必须展示来源、schema、health、permission 和 reconnect 状态。

### Goose

借鉴 Operation/Effect、approval/cancel/yield/resume、MCP extension abstraction、session/usage persistence、keyring-first、archive traversal、Sigstore/SLSA、process timeout/output limit/process-tree cleanup。不能照搬 Goose 的完整 Agent Runtime、provider registry、computer-use 和宽松 secret fallback。

### 共同结论

Control Plane 优先于 UI；durable state、live stream、projection 分离；admission 不等于 execution；event-first；visibility 与 authorization 分离；不复制 Harness Agent Loop；Runtime/App/Remote protocol 独立版本化；secret、scope、approval、update、rollback 要有状态和审计边界。

## 6. 目录和文件职责

~~~text
apps/
  desktop/
    src/main.tsx                 # startup、ensure_harness、readiness navigation
    src/updater.ts               # App updater bridge
    src-tauri/
      src/lib.rs                 # Rust supervisor/runtime/tray/single-instance
      src/main.rs
      tauri.conf.json
      tauri.ci.json
      tauri.ci.windows.json
      icons/
  remote-pwa/
    src/main.tsx                 # QR、heartbeat、notification、Remote UI
    public/sw.js
    public/manifest.webmanifest

packages/
  control-contracts/             # typed remote schema
  desktop-host/                  # Phase 2/3 Host adapters
    src/phase2/
    src/phase3.ts
  dsh-plugin-desktop/            # Harness Host plugin/apiProxy/remote adapter
  dsh-client-desktop/            # Harness Client plugin/UI slots/update
  remote-daemon/                 # control plane/device/pairing/SSE/auth
  remote-client/                 # direct/relay client
  remote-relay/                  # blind opaque relay

scripts/
  guardian/index.ts
  runtime/index.ts
  smoke/index.ts
  remote/index.ts

vendor/deepseek-harness/         # pinned upstream submodule，不得修改

docs/research/                   # 四个项目研究
docs/DSHPilot-final-architecture-improvement-plan.md
docs/DSHPilot-handoff-2026-08-15.md
~~~

关键边界：

- lib.rs：Tauri、Supervisor、Runtime path、adoption、readiness、tray、single-instance、update、close order；
- main.tsx：startup、ensure_harness、status polling、ready navigation；
- dsh-plugin-desktop：apiProxy、projection/action、workspace/remote auth、SSRF、hydrate；
- dsh-client-desktop：official client bundle、composer/sidebar slots、MCP/Token/Document/Notification、update；
- control-contracts：先改 schema，再同步 daemon/client/PWA；
- remote-daemon：source of truth、device/pairing/token、authorization；
- remote-client：协议、cursor、reconnect；
- remote-relay：opaque frame，不读明文；
- runtime/guardian/smoke：分别负责 bundle、compatibility、真实启动/插件 smoke。

## 7. 已执行验证和本机安装

### 7.1 本地通过过的命令

~~~text
pnpm install --lockfile-only
pnpm install
pnpm typecheck
pnpm lint
pnpm test                     # 8 files, 49 tests
pnpm build
cargo fmt -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm runtime:bundle
~~~

Runtime smoke 曾返回：

~~~json
{"ok":true,"url":"http://127.0.0.1:55407","bytes":12328,"hostPluginLoaded":true,"clientPlugin":true}
~~~

注意：当前 smoke 的 Client 检查不是真实 Harness module loader 执行，必须重写。

### 7.2 本机 Tauri 构建

~~~sh
TMPDIR=/Volumes/ExSSD/dshpilot-tmp \
  pnpm tauri build --debug --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false,"resources":{"../../../runtime/current":"runtime","../../../runtime/current.json":"runtime/current.json"}}}'
~~~

成功产物：

/Volumes/ExSSD/Projects/dshpilot/apps/desktop/src-tauri/target/debug/bundle/macos/DSHPilot.app

Full DMG 阶段曾因内置磁盘空间不足失败；App bundle 本身已成功。继续本地调试优先使用 --bundles app。

### 7.3 本机安装

~~~text
实际 App：/Volumes/ExSSD/Applications/DSHPilot.app
软链接：  /Users/mj/Applications/DSHPilot.app
~~~

内部盘可用空间很低，构建和临时文件用 /Volumes/ExSSD。

状态文件：

/Volumes/ExSSD/dshpilot-tmp/dshpilot-installed-status.json

曾记录：

~~~json
{
  "state": "ready",
  "phase": "adopted-external",
  "generation": 1,
  "url": "http://127.0.0.1:3080",
  "pid": 65439,
  "restart_count": 0,
  "last_error": null
}
~~~

curl http://127.0.0.1:3080/ 返回 HTTP 200、约 12076 bytes。可是外部 dsh 的 /__dshpilot/health 返回 404，说明本次只验证到 HTML 服务和 Tauri 启动，未验证 DSHPilot plugin integration。

不要直接 kill PID 65439。先：

~~~sh
ps -p 65439 -o pid,ppid,command
~~~

只有 DSHPilot 自己 owned 的 child 才能停止。

## 8. Review agent 详细结论

### 8.1 Parfit：Desktop Supervisor/Runtime/install

P0：Client Plugin 可能无法加载。Harness 要求 module loader closure/module table；当前 dsh-client-desktop 主要由 tsc 生成普通 ESM，并保留 @tauri-apps/api、@tauri-apps/plugin-updater 裸 import。Runtime 内不一定有这些包。修复为官方 Harness build/tsdown 格式，注入 Tauri bridge，增加真实 load/setup/slot smoke。

High：service registry 位于 app_data/desktop/dsh-service.json，但 desktop 目录没有创建，写入失败被静默忽略。创建目录、atomic write、错误上报，记录 owner/pid/port/generation/health/createdAt，并测试随机端口重启发现。

High：external adoption 只要 127.0.0.1:3080 返回 HTML 就接受。必须检查 /__dshpilot/health、DSHPilot marker/nonce、PID command line、owner。普通 dsh 应拒绝 adoption 或明确 compatibility mode。

High：App update 没有可靠 relaunch。统一 App update controller，session check 与 update admission 共用，安装成功后调用 relaunch，测试旧进程退出和新版本 ready。

High：current.json 存在但 Runtime 目录损坏时不能依靠当前 Runtime manager 修复。需要 Tauri/embedded bootstrap helper，按 previous、embedded、download candidate 恢复，并做 corruption tests。

Medium：start/ensure 仍可能在 state mutex 内执行长 readiness，前端又主动 ensure。tray deadlock 已修，仍需优化锁粒度和 in-flight dedupe。

Medium：App update 和 Runtime update 不能共用一个 next 状态，否则会互相覆盖。

### 8.2 Boole：Remote security

P1：ws-a device 能读取 ws-b 的 questions、artifacts、resources、events；按 ID 的 artifact/resource/lineage 也要检查 owner workspace。permission_reply 当前缺少足够 owner context。必须统一 list/get-by-id scope 并写 negative tests。

P1：readBoundedFile 先完整 readFile 再截断；relay tunnel 先 arrayBuffer 再检查大小。改为 stat + stream + bytesRead limit + abort/timeout。

P1：先 DNS lookup 再用 hostname fetch，存在 DNS rebinding 窗口。必须 pin 已验证 IP，redirect 每次重新 resolve/pin，加入 deterministic test。

P2：重启后 approval/question 被静默丢弃，running job 可能假装仍 running。生成 interrupted/stale event，PWA 清楚显示中断。

P2：PWA 从 events(0) 开始，没有持久 generation/cursor 和 gap/reset UI。Heartbeat serverInfo 不能代表 SSE 健康，应分开记录 HTTP 和 event stream state。

P2：task completed/failed 未完整转成 notification.created，service worker 没 Push API。补事件和 notification inbox。

P2：relay 只有全局 token + channel ID，没有 role ownership，拿到 token 可抢占已知 channel 造成 DoS。增加 nonce/HMAC/ephemeral key、role ownership、高熵 channel。

P2：standalone ControlPlaneServer 没 devicesPath 时 DeviceRegistry 只在内存，要求明确 data dir 或拒绝启动。

### 8.3 Pauli：README/icon/build/install

README 工作树已中英双语、SEO 关键词和 topics 已配置，SVG/PNG/ICO/ICNS 已生成，App 已安装外置盘。当前工作树又重新设计了更接近 DeepSeek 轮廓的鲸鱼图标，并重新生成了四种资源；远端 README/LICENSE/icon 尚未更新，因为未 push。Homepage 为空。App/Runtime signing、GitHub latest release、真实 updater 未验证。

### 8.4 CI 现状

已知：

- Linux：成功；
- Windows：安装后 readiness/health 失败；
- macOS：安装后 health 失败；
- Upstream Guardian：成功；
- Release run：失败；
- 关键 P0 是 chunked HTTP readiness parsing。

Rust probe 不能把 chunk size 当 JSON。需要正确处理 Content-Length、chunked、EOF body，或使用成熟 HTTP client 解析 response。

## 9. 当前未提交文件

接手时重新执行 git status。主要改动：

~~~text
 M CHANGELOG.md
 M README.md
 M apps/desktop/src-tauri/icons/icon.ico
 M apps/desktop/src-tauri/icons/icon.png
 M apps/desktop/src-tauri/src/lib.rs
 M apps/desktop/src-tauri/tauri.conf.json
 M apps/desktop/src/main.tsx
 M apps/remote-pwa/package.json
 M apps/remote-pwa/src/main.tsx
 M packages/control-contracts/src/index.ts
 M packages/desktop-host/src/phase2/tokens.ts
 M packages/dsh-client-desktop/package.json
 M packages/dsh-client-desktop/src/client.test.ts
 M packages/dsh-client-desktop/src/client.ts
 M packages/dsh-plugin-desktop/src/index.ts
 M packages/remote-daemon/src/index.test.ts
 M packages/remote-daemon/src/index.ts
 M packages/remote-daemon/src/relay-tunnel.ts
 M packages/remote-relay/src/index.ts
 M pnpm-lock.yaml
 M scripts/smoke/index.ts
?? LICENSE
?? apps/desktop/src-tauri/icons/dshpilot-mark.svg
?? apps/desktop/src-tauri/icons/icon.icns
~~~

本文件生成后也会新增。不要提交 runtime、node_modules、target、dist、status/log、secret。

## 10. 遗留问题优先级

### P0：先修才能提交

1. 修复 chunked HTTP readiness body parsing。
2. 修复 Client Plugin 官方 bundle 格式、Tauri bridge 和真实 loader smoke。
3. 修复 service registry desktop 目录、atomic write 和 error reporting。
4. 收紧 external dsh adoption，验证 health/plugin marker/identity/PID/owner。
5. App update 安装后真正 relaunch，recovery page 也接统一 session check。
6. current Runtime 损坏时由 embedded/previous bootstrap 恢复。
7. 修复默认 tauri build 的 Runtime resource overlay。
8. 已重新统一 SVG/PNG/ICO/ICNS 图标资源；提交前再做一次 Tauri bundle 视觉检查。

### P1：Remote 安全

1. questions/artifacts/resources/events list 和 get-by-id 全部 workspace scope。
2. 修复 permission_reply owner resolution。
3. bounded file 和 relay 改流式上限读取。
4. 解决 DNS rebinding 和 redirect pin。
5. relay channel role ownership、nonce/HMAC、高熵 ID。
6. standalone daemon 强制持久 data dir。
7. restart hydrate 将 stale running job 标为 interrupted 并发事件。

### P2：可靠性/产品体验

1. PWA 持久化 generation/cursor，显示 reconnecting/catch-up/gap/reset。
2. 分离 HTTP 和 SSE 状态。
3. 完整 notification.created，包括 task completed/failed。
4. MCP/import/document 改成正式 modal/form。
5. browser/WebView interaction tests。
6. Windows/macOS clean install/update/rollback E2E。
7. launchd/systemd/Windows service 部署说明。

## 11. 下一位 agent 接管命令

### 11.1 状态确认

~~~sh
cd /Volumes/ExSSD/Projects/dshpilot
git status --short
git branch --show-current
git log -5 --oneline --decorate
git submodule status
gh auth status
gh repo view zoomc/dshpilot --json nameWithOwner,description,repositoryTopics,url
~~~

### 11.2 质量检查

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cargo fmt -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
~~~

Runtime smoke：

~~~sh
runtime_id="$(node -e "const fs=require('fs'); process.stdout.write(JSON.parse(fs.readFileSync('runtime/current.json','utf8')).runtimeVersion)")"
DSHPILOT_RUNTIME_ROOT="runtime/current/versions/$runtime_id" pnpm smoke
~~~

### 11.3 审查顺序

1. lib.rs：chunked body、mutex、start/ensure dedupe、registry、adoption、bootstrap；
2. dsh-client-desktop：official bundle、Tauri bridge、update/relaunch；
3. dsh-plugin-desktop：remote authorization、scope、SSRF、hydrate；
4. remote-daemon：所有 projection route 和 get-by-id；
5. remote-relay：channel ownership 和 memory limits；
6. PWA：cursor/generation/SSE/notification；
7. CI/release：resource overlay、signing、latest.json、Windows/macOS install。

### 11.4 本机重新打包和安装

~~~sh
TMPDIR=/Volumes/ExSSD/dshpilot-tmp \
  pnpm tauri build --debug --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false,"resources":{"../../../runtime/current":"runtime","../../../runtime/current.json":"runtime/current.json"}}}'

ditto \
  apps/desktop/src-tauri/target/debug/bundle/macos/DSHPilot.app \
  /Volumes/ExSSD/Applications/DSHPilot.app
~~~

验证：

- bundled Runtime 存在；
- registry 正确写入；
- 只有正确 dsh identity/health 才导航；
- /__dshpilot/health 是 ready；
- second launch 完成 single-instance handoff；
- close 只停止 owned child；
- update action 真正在官方 sidebar.footer.action 出现；
- update 后旧进程退出、新进程 ready；
- 损坏 current 能恢复。

### 11.5 Commit/push

~~~sh
git diff --check
git diff --stat
git status --short
git diff -- apps/desktop/src-tauri/src/lib.rs
git diff -- packages/dsh-plugin-desktop/src/index.ts
git diff -- packages/remote-daemon/src/index.ts
~~~

建议：

~~~text
feat: finish desktop update and remote security integration
~~~

审查 staged 文件后：

~~~sh
git add CHANGELOG.md README.md LICENSE \
  apps packages scripts pnpm-lock.yaml \
  docs/DSHPilot-handoff-2026-08-15.md
git diff --cached --name-only
git commit -m "feat: finish desktop update and remote security integration"
git push origin main
~~~

不要把 vendor/deepseek-harness 修改、runtime、target、node_modules、status/log 或 secret 加入 commit。

## 12. CI、Guardian、Release

CI：

- Linux quality：upstream install/build、lint、typecheck、test、build、Runtime bundle、smoke；
- Windows x64：NSIS、安装后 readiness/health/single-instance/smoke；
- macOS arm64：App bundle、readiness/health/single-instance/smoke。

Guardian：

~~~text
stable SHA
→ Harness master candidate
→ candidate checkout
→ build Harness/DSHPilot
→ typecheck/test/smoke
→ Windows/macOS guardian
→ Runtime bundle
→ PASS/FAIL Summary
~~~

失败时不更新 stable SHA、current Runtime 或 release，并创建/更新 Issue。

Release secrets：

~~~text
DSHPILOT_RUNTIME_PRIVATE_KEY
DSHPILOT_RUNTIME_KEY_ID
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
TAURI_SIGNING_PUBLIC_KEY
~~~

App updater endpoint：

https://github.com/zoomc/dshpilot/releases/latest/download/latest.json

正式发布前必须验证签名、latest.json、平台 artifact、App relaunch、Runtime rollback 和用户数据隔离。当前 GitHub 没有 latest release，真实 updater 不能算已验证。

## 13. 安全规则

- 默认只监听 127.0.0.1；
- 非 loopback 必须 TLS；
- DSHPILOT_REMOTE_WORKSPACES 只列批准的 workspace roots；
- relay token 与 E2E key 分离；
- relay 不读取业务明文；
- 不在 Runtime、README、日志、Issue、CI Summary 写 API key/MCP secret/refresh token；
- current 和 previous 必须同时保留；
- 下载、解压、解析限制大小、深度、超时、临时目录和路径穿越；
- redirect 每次重新 resolve/pin；
- external dsh adoption 必须验证身份；
- adopted-external 不能被关闭；
- 不修改 upstream submodule；
- 不用 git reset --hard 或 broad recursive delete；
- 构建和缓存放外置盘。

## 14. 最终判断

当前真实状态：

~~~text
Phase 1/2/3 主线已实现
+ 本地质量检查曾通过
+ macOS Debug App 曾安装并运行
- 真实 Client Plugin loader 尚未通过
- chunked readiness 尚未修复
- external adoption 身份验证不足
- Runtime bootstrap/relaunch 有缺口
- Remote scope 有越权缺口
- Windows/macOS CI 仍有失败项
- release signing/latest release 未验证
- 当前改动未 commit/push
~~~

正确顺序：

~~~text
修 P0 Client/Supervisor/Runtime
→ 修 P1 Remote authorization/memory/SSRF/relay
→ 增加 negative/integration tests
→ 重跑本地检查
→ commit/push
→ 查看 Linux/Windows/macOS CI
→ 配置 signing release
→ clean install/update/rollback/remote 验收
~~~

下一位 agent 不需要重新研究项目背景。以本文、四份 research review、最终架构改进计划、官方 Harness pinned submodule 和当前代码为基线继续。
