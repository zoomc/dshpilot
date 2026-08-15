# Changelog

## 0.1.1 (unreleased)

- Fixed HTTP chunked-transfer decoding in the Supervisor health probe so externally adopted `dsh web` instances are detected correctly (RFC 9112).
- Fixed service-registry write to create its parent directory and surface write errors instead of silently dropping the registration.
- Restricted external Harness adoption to endpoints that report `ready` at `/__dshpilot/health`, refusing plain `dsh web` (404) handoff.
- Restored app relaunch after a Tauri auto-update by relying on the updater's built-in restart and confirming before interrupting an active session.
- Added embedded-Runtime recovery so a corrupt current + previous Runtime still boots from the bundled seed.
- Bundled the Runtime into the default macOS app build via `tauri.conf.json` resources.
- Closed remote workspace-scoping gaps: events (`/v1/events`, `/v1/events/stream`, and the control-protocol `events` request) are now filtered to a device's paired workspaces via session→workspace resolution; artifact/resource get-by-id enforces item workspace scope (fail-closed). Relay channel ownership + nonce/HMAC and a DNS-rebinding pin were added, streaming reads bound to the owner, daemon persistence and stale-job interruption hardened.
- Added negative tests proving a workspace-scoped device cannot read another workspace's events or artifact/resource by id without an explicit, allowed selector.

## 0.1.0

- Initialized the DSHPilot workspace and Phase 1 architecture baseline.
- Added Phase 2 Host foundations for MCP Manager/import, Context/Token inspection, safe document attachments, and the four native notification kinds.
- Added Harness patch generation, plugin loading smoke coverage, and the scheduled upstream Guardian workflow.
- Fixed Windows CI resource packaging by removing the recursive Junction workaround.
- Added source reviews for Paseo, OpenCode, Qwen Code, and Goose, plus the final architecture improvement plan covering the remaining Phase 1/2 work and the Phase 3 self-hosted remote roadmap.
- Added production Supervisor health/retry/process-tree handling, signed immutable Runtime update/rollback commands, packaged plugin dependency closure, and independent Tauri App updater wiring.
- Added operational Phase 2 MCP/Documents/Token Host routes and Client UI, plus Phase 3 self-hosted daemon, TLS remote mode, device pairing/refresh/revocation, replayable SSE, encrypted relay frame guards, Remote PWA, Task/Artifact/Git/Resource/Lineage projections, and Guardian packaged smoke coverage.
- Connected the self-hosted control plane to the official Harness `apiProxy`, added remote event reconnect/rate limiting, Runtime manifest URL updates with rollback-safe staging, and final packaged remote-health smoke coverage.
- Added authenticated opaque WebSocket relay transport, bounded/redacted remote event persistence, approved-workspace cwd validation, Runtime pointer recovery journal/update locks, and platform-specific Runtime release manifests.
- Added official keyless Harness RPC smoke coverage for sessions, history, models, and settings; isolated document parsing in killable workers; official credential-reference resolution for MCP Loader composition; and loader-fiber/tool-registry status reporting.
- Added Ed25519 device identity proofs for remote pairing, server-bound relay handshakes with encrypted frame replay protection, resource-level authorization hooks, stale interactive-request recovery, and packaged Runtime MCP/remote-control smoke checks.
- Completed Phase 3 remote integration: self-hosted token/TLS blind relay with rate limits and desktop outbound restricted tunnel, PWA relay control client, Host/Origin hardening, ownership checks, artifact/Git/resource projections, bounded redacted output, MCP secret filtering, cross-platform data roots, and installed-app readiness reporting for CI.
- Hardened the self-hosted relay with separate relay authentication and end-to-end encryption keys, timestamped single-use request replay protection, query-safe route validation, pairing over relay, token refresh, reconnect backoff, deterministic socket shutdown, and cross-platform Guardian desktop gates.
- Added startup adoption for an already-running loopback `dsh web`, automatic lower-left App/Runtime update actions with active-session confirmation, workspace-scoped remote pairing, QR pairing and PWA connection notifications, a custom DSHPilot app mark, bilingual SEO-focused README/About metadata, and macOS packaged-install verification.
