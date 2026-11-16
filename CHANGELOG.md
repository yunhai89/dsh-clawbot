# Changelog

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
