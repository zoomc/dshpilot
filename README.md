# DSHPilot — Desktop Workstation for DeepSeek Harness

DSHPilot is a Tauri desktop host for the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

It keeps the upstream Harness runtime isolated and adds desktop lifecycle, runtime updates, compatibility checks, and native integration without maintaining a fork of the Harness core.

## Status

Developer preview. Phase 1 is the current target: a stable desktop shell and tested upstream runtime channel.

## Principles

- Official Harness Web UI remains the UI foundation.
- Upstream source is pinned and physically isolated under `vendor/`.
- Desktop App and Harness Runtime are updated independently.
- Failed upstream candidates never replace the last known good runtime.

## Development

Prerequisites: Node.js 22.19+ and pnpm 11.7.0.

```sh
pnpm install
pnpm run typecheck
pnpm run build
```

The upstream source is provided as a pinned submodule after repository bootstrap.

## License

DSHPilot source is MIT licensed. DeepSeek Harness and third-party dependencies retain their own licenses and notices.
