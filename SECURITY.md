# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | Yes |

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository:

https://github.com/yunhai89/dsh-clawbot/security/advisories/new

Do not open a public issue for a vulnerability that could expose WeChat bot tokens, bypass the allowlist, escape a workspace, or execute commands on a host.

## Security model

- `/api/dsh-clawbot/*` exact Web routes require DSH Connection authentication in addition to the loopback/origin guard.
- The QR owner is written to the account allowlist. An account with no allowlist and no recorded owner refuses to start.
- Bot tokens, allowlists, context tokens, conversation state, and quote-cache SQLite files are stored with mode `600` under a `700` state directory. Permissions are re-hardened periodically.
- QR polling base URLs are restricted to Tencent HTTPS origins to prevent SSRF.
- `workspaceRoots` can confine workspace creation and switching to deployment-owned directories.
- Tool approvals are forwarded to WeChat and time out fail-closed.
- `/logout` requires an explicit confirmation.

## Deployment guidance

- Do not expose DSH Web directly to the public internet. Use an SSH tunnel, VPN, or an authenticated reverse proxy.
- Keep `permissionPreset` at `workspace-write` unless the WeChat account is fully trusted.
- Use a dedicated WeChat account for the bot, not a primary account.
- Treat WeChat messages as untrusted input: they can contain forwarded text, links, and prompt-injection attempts.
- Audit `allowFrom` files and account tokens after sharing a machine.
