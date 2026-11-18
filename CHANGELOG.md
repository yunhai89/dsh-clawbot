# Changelog

## 0.1.4 — 2026-11-19

Goal mode and truthful failure reporting.

- Add `/goal <objective>` (aliases `/target`, `/目标`) to create a DSH goal directly from WeChat without the model-only `create_goal` authority check
- Add `/goal` status plus `edit`, `pause`, `resume`, `complete`, `block`, `rounds`, and `clear`
- Push each automatic goal round back to WeChat as `【目标 · 第 N 轮】`; add `goalProgress` to disable round messages
- Report the real `turn/end` failure (message, code, HTTP status, request id, reason kind) instead of falling back to `已执行：<tool list>`
- Keep the executed tool list as secondary context after an error
- Deliver files declared with DSH's `present` tool to WeChat after the turn
- Add native outbound voice via `VOICE` items using the plugin's CDN primitives: pass through `.silk`, encode `.wav` with `silk-wasm`, transcode other formats with `ffmpeg` when available, and fall back to a file when conversion or sending fails
- Add `/voice <path> [caption]`; extend `/send` with captions, quoted paths, and shared workspace confinement
- Add per-agent prompt guidance so models use `present` for WeChat media
- Add `silk-wasm` dependency for WAV-to-SILK encoding
- Cover goal commands, goal-round delivery, mid-turn quota errors, outbound media, and voice in tests

## 0.1.3 — 2026-11-16

- Route subagent approval requests to the owning WeChat conversation by walking `parentSession`
- Cache child-agent `tool/call` arguments for approval prompts
- Mark delegated approvals with a `子 Agent` source line
- Add a subagent approval routing test

## 0.1.2 — 2026-11-16

Tool approval adaptation.

- Approval prompts now include the conversation, tool name, actual command/file path, and approval reason
- Tool arguments are captured from `tool/call` events and cached by `callId`
- Approval text redacts tokens, API keys, passwords, and Bearer credentials before sending
- Multiple approvals in one WeChat chat are queued and delivered one at a time instead of failing the second request
- Approval timeouts and aborts resolve as cancelled and advance the queue
- Bare `1`/`2`/`y`/`n` are no longer accepted as approval decisions; use `/approve` or `/reject`

## 0.1.1 — 2026-11-16

Security and performance hardening.

- Protect `/api/dsh-clawbot/*` with DSH Connection `requestRejection()` in addition to the loopback guard
- Fail-closed allowlist: refuse to start an account with no allowlist and no recorded owner
- Harden state directory `700` and credential/state files `600` every five minutes
- Restrict QR polling base URLs to Tencent HTTPS origins (SSRF guard)
- Require explicit `{"confirm":true}` for logout; Web UI asks for confirmation
- Reuse the active QR code for 60 seconds; reject unknown QR sessions
- Add `workspaceRoots` to confine workspace creation/switching
- Stream attachments above 2 MB via `saveFileStream`
- Coalesce `lastActiveAt` writes and reap idle agents
- Pause Web status polling while the tab is hidden
- Add tests for SSRF, workspace roots, and streaming attachments

## 0.1.0 — 2026-11-16

Initial public release.

- DSH bundle for WeChat ClawBot (Tencent iLink)
- OpenClaw host compatibility layer around the unmodified `@tencent-weixin/openclaw-weixin` plugin
- Web QR login card and `/api/dsh-clawbot/*` local routes
- Per-WeChat-user persistent DSH Sessions with resume
- Conversation commands: `/new`, `/list`, `/use`, `/title`
- Model commands: `/model`, `/model <index|provider/model|default>`
- Workspace commands: `/workspace`, `/workspace new`, `/workspace here`
- Tool approval forwarding: `/approve`, `/reject`
- Inbound image/file attachments and outbound files via `/send`
- Owner allowlist after QR login
