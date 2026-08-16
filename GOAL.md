# Goal: 完成 DSHPilot 全量修复（P0/P1/P2）—— 全部绿、合并 main、push、本地重装

## Acceptance Criteria（验收标准，必须可验证）
- [x] AC1: 质量门全绿 — `pnpm typecheck` / `pnpm lint` / `pnpm test`(71) / `cargo check` / `cargo test`(6)
- [x] AC2: P0 全闭环（chunked health 解码、registry 建目录、外部采纳门禁、更新重启、内置 runtime 引导、bundle 含 runtime）
- [x] AC3: P1 全闭环（remote workspace 作用域、relay 归属+HMAC、DNS-rebind pin、streaming 读 owner 绑定、daemon 持久化、stale job 中断、control-protocol events 作用域）
- [x] AC4: subagent 独立 review 通过（含补齐 control-protocol events 旁路）
- [x] AC5: 已 commit 并 push 到 origin main
- [x] AC6: 本地重装 — debug `.app` ditto 到 `/Volumes/ExSSD/Applications/DSHPilot.app`，二进制为 19:04 最新构建
- [x] AC7: 构建配置修复（tauri.conf.json / vite.config.ts）提交并 push（8acfbd7）

## Subtasks（有序子任务）
- [x] 1. 特性状态梳理 + 开发计划（表格 + 验收标准）
- [x] 2. Rust P0 修复（lib.rs）
- [x] 3. TS P1 修复（remote-daemon / relay / plugin / client / contracts / pwa）
- [x] 4. 质量门 + cargo 测试
- [x] 5. 独立 review + 补齐 control-protocol events 旁路 + 测试
- [x] 6. commit P0/P1 修复 + CHANGELOG
- [x] 7. push origin main
- [x] 8. `tauri build --debug --bundles app` 成功（仅 updater 签名可选步因无密钥跳过）
- [x] 9. 本地重装：ditto 最新 bundle → 安装目录
- [x] 10. 提交构建配置修复并 push（8acfbd7）
- [x] 11. 最终核验：typecheck/lint/71 tests/cargo check/6 Rust tests 全绿

## State
status: achieved
iteration: 11
budget_tokens: 充足
