# Changelog

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
