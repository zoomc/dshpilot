# Changelog

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
