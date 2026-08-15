# DSHPilot — Desktop Workstation for DeepSeek Harness

DSHPilot is a Tauri desktop host for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

It keeps the upstream Harness runtime isolated and adds desktop lifecycle, runtime updates, compatibility checks, and native integration without maintaining a fork of the Harness core.

## Status

Developer preview. Phase 2 foundations are now present: MCP configuration/import, token inspection, safe document providers, and native notification boundaries. The official Harness Web UI remains authoritative; Phase 3 is not started.

## Principles

- Official Harness Web UI remains the UI foundation.
- Upstream source is pinned and physically isolated under `vendor/`.
- Desktop App and Harness Runtime are updated independently.
- Failed upstream candidates never replace the last known good runtime.
- MCP configuration is written as an explicit, reviewable Harness patch; imported secrets are omitted or represented by environment references.
- Document attachments are stored content-addressed below `DSH_HOME`, exposed as manifests first, and read on demand with archive/path limits.

## Development

Prerequisites: Node.js 22.19+ and pnpm 11.7.0.

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm test
pnpm smoke
```

The upstream source is provided as a pinned submodule after repository bootstrap.

## License

DSHPilot source is MIT licensed. DeepSeek Harness and third-party dependencies retain their own licenses and notices.
