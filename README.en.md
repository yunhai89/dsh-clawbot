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
- Goal mode: `/goal <objective>` creates a DSH goal directly and reports each continuation round back to WeChat
- Workspace management: `/workspace`, `/workspace new`, `/workspace here`
- Tool approvals forwarded to WeChat with tool name, command/path, and reason, with secret redaction; `/approve` grants one operation and `/reject` denies it, queued per chat
- Inbound images/files through DSH attachments
- Outbound images/files/videos: `/send` for workspace files, plus automatic delivery of files declared with `present`
- Outbound voice: `/voice` converts `.silk`/`.wav` audio (and other formats when `ffmpeg` is available) into native WeChat VOICE items, falling back to a file when conversion or sending fails
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
| `/goal` | Show the current goal and continuation state |
| `/goal <objective>` | Create a goal directly; aliases `/target`, `/目标` |
| `/goal edit <objective>` | Edit the current goal |
| `/goal pause` / `/goal resume` | Pause or resume automatic continuation |
| `/goal complete` | Mark the goal complete |
| `/goal block <reason>` | Mark the goal blocked |
| `/goal rounds <n>` | Change the continuation round cap |
| `/goal clear` | Clear the current goal |
| `/status` | Show account, conversation, model, agent status |
| `/stop` | Stop the current task |
| `/whoami` | Show account/user/conversation id |
| `/send <path> [caption]` | Send a workspace image/file/video (quoted paths supported) |
| `/voice <path> [caption]` | Convert workspace audio into a native WeChat voice message, falling back to a file |
| `/approve` / `/reject` | Approve or reject a tool request |
| `/help` | Show help |

`/workspace` switching opens a new conversation because DSH binds its sandbox/write roots to the Session `cwd` at creation. Old conversations are preserved.

### Goal mode

Ordinary WeChat messages enter DSH as `source.kind = clawbot`, so the model cannot create a goal with the `create_goal` tool: that tool only accepts a direct human message in a top-level turn. `/goal` bypasses the model and calls the goal service directly:

```text
/goal Fix all failing tests and commit
```

DSH's goal-round driver then continues automatically. Each round, error, and terminal state is pushed back to WeChat as `【目标 · 第 N 轮】`. If a quota or other error stops continuation, the message tells you to send `/goal resume`.

### Outbound images, files, videos, and voice

```text
/send report.pdf Final report
/send "output/screenshot.png"
/voice voice.mp3 Listen to this
```

- `/send` routes images, videos, and other files through Tencent's media sender. Paths must stay inside the current workspace.
- `/voice` builds a native WeChat VOICE item: `.silk` passes through, `.wav` is encoded to 16 kHz SILK with the bundled `silk-wasm`, and `.mp3`/`.ogg`/`.m4a`/etc. require `ffmpeg` on PATH. Conversion or send failures fall back to a file attachment.
- Files declared with DSH's `present` tool are sent to WeChat after the turn. Workspace audio uses the voice path; other files use the image/video/file path.
- There is no TTS: voice messages require an existing audio file.
- iLink may silently drop native bot voice bubbles on some accounts even when the send API succeeds. Use `/send` when a reliable audio file is required.

---

## Configuration

Override the `clawbot` row in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: clawbot
  name: dsh-clawbot
  config:
    workspace: /root/.dsh/clawbot/workspace
    workspaceRoots: []
    agentPreset: standard
    permissionPreset: workspace-write
    provider: deepseek-official
    model: deepseek-flash
    allowUsers: []
    allowAllUsers: false
    approvalTimeoutMs: 300000
    idleAgentTimeoutMs: 1800000
    replyProgress: true
    goalProgress: true
    autoStart: true
    debug: false
```

`goalProgress` controls whether automatic goal-round results are pushed to WeChat (default `true`). State lives under `$DSH_HOME/clawbot` (tokens, allowlist, media, `conversations.json`).

---

## Security

- Exact `/api/dsh-clawbot/*` routes additionally call DSH Connection `requestRejection()`; an unauthenticated local process cannot start login, log out, or read status.
- The QR owner is written to the allowlist. If an account has neither an allowlist nor a recorded owner, the monitor refuses to start (fail-closed).
- Default `workspace-write`; cross-boundary tool calls require `/approve`. Approval prompts show the tool, command/path, and reason with secret redaction; multiple approvals queue per chat, and subagent approvals are routed back to the owning WeChat conversation through `parentSession`.
- State files are `600` under a `700` directory, and permissions are re-hardened every five minutes.
- QR polling `baseUrl` is restricted to Tencent HTTPS origins; internal addresses and credentialed URLs are rejected.
- `workspaceRoots` can confine workspace switching/creation to a deployment-owned directory tree.
- `/logout` requires an explicit `{"confirm":true}` and the Web UI asks for confirmation.
- Do not expose DSH Web publicly. Use an SSH tunnel or an authenticated reverse proxy.
- WeChat messages go through Tencent servers; they are not end-to-end encrypted.
- Do not use `danger-full-access` unless you fully trust the WeChat account.

## Performance

- Non-blocking inbound dispatch keeps the long poll receiving while an agent runs.
- Files above 2 MB stream through `saveFileStream` instead of buffering in the Node heap.
- Model catalog queries are cached for 60 seconds and run in parallel with per-provider timeouts.
- `lastActiveAt` writes are coalesced for 500 ms; structural changes persist immediately.
- Idle agents are reaped after 30 minutes by default; sessions remain resumable.
- The Web card pauses status polling while the tab is hidden.

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

### What does a tool permission request look like in WeChat?

It shows the conversation, tool name, the actual command or file path, and the approval reason, followed by `/approve` or `/reject`. Tokens, API keys, and passwords in the command are redacted. Multiple approvals for one chat are queued and sent one at a time.

### Model returns 401 or MISSING_CREDENTIAL?

Fix the provider credentials in DSH Models, or set a working `provider`/`model` for the `clawbot` row. This is not a WeChat channel issue.

### Why does asking DSH in chat to create a goal fail?

DSH's `create_goal` tool requires a direct human message (`source.kind = user`) in the current top-level turn. WeChat messages are injected with `source.kind = clawbot`, so the tool rejects the model. Use `/goal <objective>` instead; it calls the goal service directly.

### Why did a failed turn only show "已执行：..."?

Older versions checked assistant text and otherwise fell back to a tool-name list, hiding the real failure. The adapter now reports the concrete error, code, and HTTP status, followed by any tools that ran before the failure.

### Can WeChat send images, files, videos, and voice messages?

Yes. Use `/send` for images/files/videos and `/voice` for voice. Files declared by the model through `present` are also delivered automatically after the turn. Voice requires an existing audio file; text-to-speech is not included. `.silk` and `.wav` work directly, while other formats need `ffmpeg` for conversion. All outbound paths are confined to the current workspace so the model cannot exfiltrate files from elsewhere.

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
