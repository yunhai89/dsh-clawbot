# dsh-clawbot — WeChat ClawBot channel for DeepSeek Harness (DSH)

[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1%20~%200.2.x-4f46e5)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.9-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![WeChat ClawBot](https://img.shields.io/badge/WeChat-ClawBot-07C160?logo=wechat&logoColor=white)](https://github.com/Tencent/openclaw-weixin)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

[简体中文](./README.md) | **English**

Connect **WeChat ClawBot (Tencent iLink)** to **DeepSeek Harness (DSH)**. Chat with your DSH agent from WeChat, run tasks, use tools, switch models, conversations, and workspaces.

`dsh-clawbot` is a DSH bundle and a WeChat ClawBot channel adapter. It does **not** reimplement the WeChat protocol. Instead, it embeds Tencent's official [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) unchanged and adds a small **OpenClaw host compatibility layer**, so QR login, long polling, `context_token`, CDN encryption, voice, quotes, and retries stay maintained by Tencent.

> Keywords: WeChat ClawBot, WeChat bot, DeepSeek Harness, DSH plugin, Tencent iLink, iLink Bot API, OpenClaw compatibility layer, AI agent, Cordis.

---

## Features

- QR login inside the DSH Web UI
- One persistent DSH Session per WeChat user, resumed after restart
- Text chat: final assistant reply is sent back to WeChat
- Conversation management: `/new`, `/list`, `/use`, `/title`
- Model switching per conversation: `/model`
- Workspace management: `/workspace`, `/workspace new`, `/workspace here`
- Tool approvals forwarded to WeChat: `/approve`, `/reject`
- Inbound images/files through DSH attachments
- Owner allowlist written automatically after QR login
- Non-blocking inbound dispatch: agents run in the background while the WeChat long poll keeps receiving

---

## Architecture

```text
WeChat App
  ↕  WeChat servers
ClawBot / Tencent iLink backend (ilinkai.weixin.qq.com)
  ↕  HTTPS / ilink/bot/*
Tencent plugin @tencent-weixin/openclaw-weixin (unmodified)
  ↕  OpenClaw ChannelPlugin / channelRuntime contract
Compatibility layer (src/compat, OpenClaw host shim)
  ↕  WeixinTransport (InboundMessage / OutboundReply)
A adapter (src/adapter.js, DSH bundle)
  ↕  ctx.agents / session/event / attachments / approval
DeepSeek Harness (DSH)
```

| Layer | Responsibility | Does not know |
|---|---|---|
| **A adapter** | WeChat peer → DSH Session, `agent.followup()`, `session/event`, attachments, approvals, commands, models, workspaces | OpenClaw, iLink |
| **Compatibility layer** | Implements the `openclaw/plugin-sdk/*` stubs and `channelRuntime` used by Tencent's plugin | DSH Agent internals |
| **Tencent plugin** | QR login, long polling, `context_token`, CDN AES, voice, quotes, retries, sending | DSH |

The compatibility layer only implements the 7 `plugin-sdk` subpaths and roughly 10 `channelRuntime` methods that Tencent's plugin actually calls. It does not implement the WeChat protocol.

---

## Compatibility

| Component | Requirement |
|---|---|
| DSH | `>=0.2.2-rc.1 <0.4.0` |
| Node.js | `>=24.9.0` |
| Tencent plugin | `@tencent-weixin/openclaw-weixin@2.4.10` |
| WeChat | ClawBot entry available under Settings → Plugins |

Verified on DSH `0.2.2-rc.1` and `0.2.2-rc.3`.

---

## Install

```sh
git clone git@github.com:yunhai89/dsh-clawbot.git
cd dsh-clawbot
pnpm install
dsh plugin --profile web add file:"$PWD"
dsh web
```

Then open DSH Web → **Plugins** → **dsh-clawbot** → **WeChat ClawBot** → **Scan QR code**.

After scanning, send `/whoami` in WeChat. It does not call a model and verifies the full channel.

---

## Commands

| Command | Description |
|---|---|
| `/new [title]` | Start a new conversation; inherits current model and workspace |
| `/list` | List conversations for this WeChat user |
| `/use <index\|id\|title>` | Switch to a conversation |
| `/title <title>` | Rename the current conversation |
| `/workspace` / `/ws` | List workspaces |
| `/workspace <index\|title\|path>` | Switch workspace (starts a new conversation there) |
| `/workspace new <path> [title]` | Create and register a workspace |
| `/workspace here` | Show the current workspace |
| `/model` | List current/available models |
| `/model <index\|provider/model\|default>` | Switch model |
| `/status` | Show account, conversation, model, agent status |
| `/stop` | Stop the current task |
| `/whoami` | Show account/user/conversation id |
| `/send <path>` | Send a file from the current workspace |
| `/approve` / `/reject` | Approve or reject a tool request |
| `/help` | Show help |

`/workspace` switching opens a new conversation because DSH binds its sandbox/write roots to the Session `cwd` at creation. Old conversations are preserved.

---

## Configuration

Override the `clawbot` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: clawbot
  name: dsh-clawbot
  config:
    workspace: /root/.dsh/clawbot/workspace
    agentPreset: standard
    permissionPreset: workspace-write
    provider: deepseek-official
    model: deepseek-flash
    allowUsers: []
    approvalTimeoutMs: 300000
    autoStart: true
    debug: false
```

State lives under `$DSH_HOME/clawbot` (tokens, allowlist, media, `conversations.json`).

---

## Security

- The QR owner is written to the allowlist; other WeChat users are rejected.
- Default `workspace-write`; cross-boundary tool calls require `/approve`.
- Do not expose DSH Web publicly. Use an SSH tunnel or an authenticated reverse proxy.
- WeChat messages go through Tencent servers; they are not end-to-end encrypted.
- Do not use `danger-full-access` unless you fully trust the WeChat account.

---

## FAQ

### Do I need OpenClaw installed?

No. The compatibility layer ships a minimal `openclaw` package with only the `plugin-sdk` subpaths Tencent's plugin uses.

### Why does switching workspace open a new conversation?

DSH binds the sandbox and write roots to the Session `cwd` at creation. A new conversation in the target workspace keeps filesystem permissions correct; the old conversation is preserved.

### Does it support group chats?

No. Tencent's plugin currently declares direct chats only.

### Images, voice, and files?

Images are downloaded, decrypted, and stored as DSH attachments (a vision model is required to see them). Files and videos are stored as attachments. Voice prefers Tencent's transcript; otherwise it is saved as a file.

### Model returns 401 or MISSING_CREDENTIAL?

Fix the provider credentials in DSH Models, or set a working `provider`/`model` for the `clawbot` row. This is not a WeChat channel issue.

---

## Limitations

- Direct chats only.
- QR code expires in about 5 minutes; refresh from the Web card.
- iLink tokens can expire; re-scan when required.
- Deep imports into Tencent's `dist/src/*` are version-sensitive; run tests when upgrading the plugin.
- Local `file:` installs require re-adding the plugin after adding new source files.

---

## License

[MIT](./LICENSE) © 2026 yunhai89
