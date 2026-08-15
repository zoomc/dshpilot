# DSHPilot — Desktop Workstation for DeepSeek Harness

DSHPilot is a Tauri desktop host for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

It keeps the upstream Harness runtime isolated and adds desktop lifecycle, runtime updates, compatibility checks, and native integration without maintaining a fork of the Harness core.

## Status

Developer preview. Phase 1/2 desktop integration and the Phase 3 self-hosted control plane are implemented. The official Harness Web UI remains authoritative; DSHPilot adds a Tauri OS shell, signed runtime lifecycle, restricted remote API, encrypted relay transport, and optional Remote PWA.

## Principles

- Official Harness Web UI remains the UI foundation.
- Upstream source is pinned and physically isolated under `vendor/`.
- Desktop App and Harness Runtime are updated independently.
- Failed upstream candidates never replace the last known good runtime.
- MCP configuration is written as an explicit, reviewable Harness patch; imported secrets are omitted or represented by environment references.
- Document attachments are stored content-addressed below `DSH_HOME`, exposed as manifests first, and read on demand with archive/path limits.
- Remote mode is opt-in. Loopback is the default; non-loopback binding requires TLS, one-time pairing, per-device scopes, expiring access tokens, refresh-token rotation, and revocation.

## Development

Prerequisites: Node.js 22.19+ and pnpm 11.7.0.

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm smoke
```

Build a self-hosted control plane for LAN/VPN use:

```sh
pnpm remote:serve -- --data ./app-data --port 6767
```

For a non-loopback control-plane bind, set `DSHPILOT_REMOTE_HOST=0.0.0.0 DSHPILOT_REMOTE_TLS_KEY=/path/server.key DSHPILOT_REMOTE_TLS_CERT=/path/server.crt` before starting; non-loopback mode refuses to start without TLS. Generate a one-time offer out-of-band with `DSHPILOT_REMOTE_PRINT_PAIRING=1`, or explicitly expose `POST /v1/pairing/offer` only to a direct local client with `DSHPILOT_REMOTE_ALLOW_LOCAL_PAIRING=1`; admin scope is never granted by HTTP pairing unless `DSHPILOT_REMOTE_ALLOW_LOCAL_ADMIN=1` is explicitly enabled by the embedding application. The Tauri-managed Harness can expose the same control plane by setting `DSHPILOT_REMOTE_CONTROL=1`; use `DSHPILOT_REMOTE_HOST`, `DSHPILOT_REMOTE_PORT`, `DSHPILOT_REMOTE_TLS_KEY`, `DSHPILOT_REMOTE_TLS_CERT`, `DSHPILOT_REMOTE_CORS`, and `DSHPILOT_REMOTE_WORKSPACES` to configure it. The remote adapter calls the official Harness `apiProxy` for session, prompt, cancel, approval, question projection, and redacted event operations; it is not a general Harness RPC proxy. `pnpm remote:serve` starts the official `dsh web` profile with the DSHPilot Host/Client patch; the reusable `@dshpilot/remote-daemon` package supplies the control-plane server and is mounted by that Host plugin.

Desktop App updates and Harness Runtime updates are separate. The desktop startup screen can install the signed Runtime manifest from the tested release channel and health-check/rollback it. Release builds require `TAURI_SIGNING_PRIVATE_KEY` for Tauri updater artifacts and `DSHPILOT_RUNTIME_PRIVATE_KEY` for tested Runtime bundles; unsigned Runtime bundles are accepted only by development commands.

The upstream source is provided as a pinned submodule after repository bootstrap.

## License

DSHPilot source is MIT licensed. DeepSeek Harness and third-party dependencies retain their own licenses and notices.
