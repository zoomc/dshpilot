<div align="center">
  <img src="apps/desktop/src-tauri/icons/dshpilot-mark.svg" alt="DSHPilot logo" width="128" height="128" />
  <h1>DSHPilot</h1>
  <p><strong>A polished desktop shell and self-hosted remote control plane for DeepSeek Harness.</strong></p>
  <p>
    <a href="https://github.com/zoomc/dshpilot/actions"><img src="https://img.shields.io/github/actions/workflow/status/zoomc/dshpilot/ci.yml?label=CI&logo=github" alt="CI status" /></a>
    <a href="https://github.com/zoomc/dshpilot/blob/main/LICENSE"><img src="https://img.shields.io/github/license/zoomc/dshpilot" alt="MIT license" /></a>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/upstream-DeepSeek%20Harness-1f6feb" alt="DeepSeek Harness upstream" /></a>
    <a href="https://github.com/zoomc/dshpilot/releases"><img src="https://img.shields.io/github/v/release/zoomc/dshpilot?include_prereleases&label=tested%20channel" alt="Tested channel" /></a>
  </p>
  <p><a href="#english">English</a> · <a href="#中文">中文</a></p>
</div>

> Developer preview · Tauri 2 · Rust · TypeScript · pnpm

## English

### About

DSHPilot is a cross-platform DeepSeek Harness desktop application for macOS, Windows, and Linux. It keeps the official `deepseek-harness` Web UI and Agent Loop authoritative, while adding the operating-system layer that a desktop product needs: process supervision, a bundled Node Runtime, single-instance behavior, tray integration, native notifications, signed Runtime updates, and a self-hosted restricted remote PWA.

The project is deliberately built as a `dsh-plugin` and `dsh-client` extension around the official Harness seams. Upstream source is pinned as a physical submodule under `vendor/deepseek-harness`; DSHPilot does not fork or patch the Harness core.

### Highlights

- **Reliable desktop lifecycle** — starts `dsh web` before the WebView navigates, adopts an already-running loopback service, captures logs, performs readiness checks, restarts unexpected exits with bounded backoff, and shuts down gracefully.
- **Independent update channels** — Desktop App updates and tested Harness Runtime updates are separate. Runtime candidates are verified, smoke-tested, atomically activated, and rolled back to `previous` on failure.
- **Official Harness integration** — MCP, sessions, composer, attachments, usage projections, RPC, UI slots, and module loading remain Harness-owned. DSHPilot adds adapters and additive slots.
- **Self-hosted remote mode** — an opt-in restricted control plane, per-device pairing and scopes, workspace-scoped access, expiring tokens, refresh rotation, event cursors, and an optional blind E2E relay for desktops that cannot accept inbound traffic.
- **Phase 2 productivity layer** — MCP management/import preview, token/context inspection, bounded document attachments, notifications, artifact presentation, Git/diff presentation, and session lineage.
- **Security boundaries** — loopback by default, TLS required for non-loopback remote binds, SSRF-resistant URL resources, bounded archives and reads, no credential persistence in Runtime directories, and no general RPC proxy through the remote API.

### Architecture

```text
┌─────────────────────── DSHPilot Desktop ───────────────────────┐
│ Tauri OS shell · WebView · tray · updater · Keychain           │
│        └── Harness Supervisor ── bundled Node Runtime          │
│                └── official dsh web + additive Host/Client     │
│                                                                  │
│ Optional self-hosted control plane ── restricted API            │
│        ├── direct TLS connection                                │
│        └── blind E2E relay ── Remote PWA                        │
└──────────────────────────────────────────────────────────────────┘
```

The remote relay is intentionally blind: it authenticates channel membership and forwards opaque encrypted frames, but cannot inspect Harness sessions, prompts, files, credentials, or model traffic. The control plane exposes projections and explicitly admitted actions rather than a full Harness RPC tunnel.

### Quick start

Requirements: Node.js 22.19+, pnpm 11.7+, Rust, and Cargo.

```sh
git clone --recurse-submodules https://github.com/zoomc/dshpilot.git
cd dshpilot
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Run the desktop development shell:

```sh
pnpm tauri dev --manifest-path apps/desktop/src-tauri/Cargo.toml
```

The application bundles and manages its own Runtime in packaged builds. Users do not need to install Node.js, pnpm, or the `dsh` command separately.

### Self-hosted remote PWA

Run a local control plane:

```sh
pnpm remote:serve -- --data ./app-data --port 6767
```

For a remote TLS bind, configure `DSHPILOT_REMOTE_HOST`, `DSHPILOT_REMOTE_TLS_KEY`, `DSHPILOT_REMOTE_TLS_CERT`, `DSHPILOT_REMOTE_ALLOWED_HOSTS`, `DSHPILOT_REMOTE_CORS`, and `DSHPILOT_REMOTE_WORKSPACES`. Pair a browser device with a one-time offer; the offer carries the allowed workspace scope and can be rendered as a QR code by the Remote PWA.

For outbound-only hosting, run the independent relay with a long random relay token and a separate E2E key:

```sh
DSHPILOT_RELAY_TOKEN='use-a-long-random-base64url-token' \
DSHPILOT_RELAY_HOST=0.0.0.0 \
DSHPILOT_RELAY_TLS_KEY=/etc/dshpilot/relay.key \
DSHPILOT_RELAY_TLS_CERT=/etc/dshpilot/relay.crt \
DSHPILOT_RELAY_ALLOWED_HOSTS=relay.example.com \
DSHPILOT_RELAY_ALLOWED_ORIGINS=https://remote.example.com \
pnpm relay:serve
```

The desktop uses `DSHPILOT_REMOTE_RELAY_URL`, `_TOKEN`, `_CHANNEL`, and the separate `_KEY`. Relay channels have bounded lifetime/idle cleanup, handshake and frame rate limits, replay protection, and a maximum of two authenticated peers.

### Development and compatibility

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm smoke
pnpm guardian
```

The daily upstream Guardian builds a candidate Harness checkout, runs compatibility and Web/Desktop smoke tests, and only promotes a Runtime after the complete tested path passes. Runtime artifacts are signed in release CI; unsigned Runtime bundles are accepted only by explicit development commands.

### Related projects and keywords

DeepSeek Harness · `dsh-plugin` · `deepseek-harness-desktop` · self-hosted AI agent desktop · Tauri AI workstation · MCP manager · Remote PWA · encrypted relay · local-first developer tools.

## 中文

### 关于 DSHPilot

DSHPilot 是面向 macOS、Windows 和 Linux 的 DeepSeek Harness 桌面端。它保留官方 `deepseek-harness` 的 Web UI 与 Agent Loop 作为唯一事实来源，把桌面产品需要的系统能力放到 Tauri/Rust 层：进程监督、内置 Node Runtime、单实例、托盘、原生通知、签名 Runtime 更新，以及可自托管的受限 Remote PWA。

项目以官方 Harness 的扩展边界为基础实现 `dsh-plugin` 与 `dsh-client`，不维护 Harness 核心分叉。上游源码以固定 submodule 放在 `vendor/deepseek-harness`，自有代码与上游物理隔离。

### 主要能力

- **稳定启动与退出**：启动时先确认 `dsh web` 已就绪，再导航 WebView；能够接管已运行的 loopback 服务，捕获日志，检测异常退出并按退避策略重启。
- **应用与 Runtime 分离更新**：桌面 App 和 Harness Runtime 独立更新。Runtime 会校验签名与哈希、执行本地 smoke test、原子切换，并在失败时恢复 `previous`。
- **官方能力优先**：MCP、Session、Composer、附件、Token Usage、RPC、UI Slot 和 Module Loader 继续由官方 Harness 管理，DSHPilot 只增加适配层和插件。
- **自托管远程控制**：可选的受限控制面、一次性配对、设备 Scope、workspace 级权限、过期 Token、事件游标，以及用于无法入站连接场景的盲转发 E2E Relay。
- **第二、三阶段能力**：MCP 管理与导入预览、Context/Token Inspector、文档附件、通知、Artifact 只读展示、Git/Diff、Session lineage 和 Remote PWA。
- **安全边界**：默认只监听 localhost；远程绑定必须 TLS；URL 资源防 SSRF；归档、读取、解压和临时目录均有上限；Runtime 目录不保存用户凭据；Remote API 不提供完整 RPC 代理。

### 快速开始

```sh
git clone --recurse-submodules https://github.com/zoomc/dshpilot.git
cd dshpilot
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

开发模式运行桌面端：

```sh
pnpm tauri dev --manifest-path apps/desktop/src-tauri/Cargo.toml
```

打包后的应用会携带并管理自己的 Runtime，用户不需要单独安装 Node.js、pnpm 或 `dsh`。

### 自托管 Remote PWA

可以通过 `DSHPILOT_REMOTE_*` 环境变量启用 TLS 控制面，并设置 `DSHPILOT_REMOTE_WORKSPACES` 限定可访问的 workspace。一次性 pairing offer 会携带 workspace 范围，Remote PWA 可以把它显示为二维码。

如果桌面无法接受入站连接，可以部署独立 blind relay。Relay 只转发端到端加密的 opaque frame，不保存或读取 Harness 数据；频道具有握手超时、帧速率限制、重放保护、空闲/最长生命周期清理和双端上限。

### 项目原则

官方 Harness 是业务事实源；Tauri 负责 OS、进程、Runtime 和更新；Remote 只暴露投影和明确允许的控制动作；上游不兼容时保持当前 tested Runtime 不变。

## License

DSHPilot source is MIT licensed. DeepSeek Harness and third-party dependencies retain their own licenses and notices.
