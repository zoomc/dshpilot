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
