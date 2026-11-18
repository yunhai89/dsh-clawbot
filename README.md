# dsh-clawbot — 微信 ClawBot × DeepSeek Harness (DSH) 适配器

[![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1%20~%200.2.x-4f46e5)](https://github.com/deepseek-ai/deepseek-harness)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24.9-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![WeChat ClawBot](https://img.shields.io/badge/WeChat-ClawBot-07C160?logo=wechat&logoColor=white)](https://github.com/Tencent/openclaw-weixin)
[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

**简体中文** | [English](./README.en.md)

把微信 **ClawBot（腾讯 iLink）** 接进 **DeepSeek Harness (DSH)**：在微信里直接和 DSH Agent 聊天、派活、跑命令、读写工作区、切换模型和会话。

`dsh-clawbot` 是一个 DSH 插件（bundle），也是一个 **WeChat ClawBot channel adapter**。它不重写微信协议，而是把腾讯官方的 [`@tencent-weixin/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin) 原样嵌进来，再补一层很小的 **OpenClaw 宿主兼容层**。扫码、长轮询、`context_token`、CDN 加解密、语音、引用、重试继续由腾讯插件维护。

> 关键词：微信 ClawBot、微信机器人、DeepSeek Harness 微信插件、DSH 微信通道、Tencent iLink、iLink Bot API、OpenClaw 兼容层、WeChat bot、AI Agent 远程控制。

---

## 目录

- [这是什么](#这是什么)
- [功能特性](#功能特性)
- [架构原理](#架构原理)
- [兼容性](#兼容性)
- [安装](#安装)
- [首次扫码登录](#首次扫码登录)
- [微信内指令](#微信内指令)
- [配置](#配置)
- [目录结构](#目录结构)
- [开发与测试](#开发与测试)
- [安全模型](#安全模型)
- [常见问题 FAQ](#常见问题-faq)
- [已知限制](#已知限制)
- [License](#license)

---

## 这是什么

`dsh-clawbot` 解决的是这个问题：

> **能不能不装 OpenClaw，也让微信 ClawBot 直接连到 DeepSeek Harness？**

可以。微信 ClawBot 的协议层在腾讯的 `openclaw-weixin` 插件里，而它和 OpenClaw 的耦合只有一层很薄的「宿主接口」。本项目的做法是：

1. **A 适配器**：DSH 侧插件，负责 Session、Agent、模型、工作区、附件、审批、微信指令。
2. **兼容层**：实现腾讯插件需要的 OpenClaw `channelRuntime` 和 `plugin-sdk` 桩，让腾讯插件以为自己在 OpenClaw 里跑。
3. **腾讯插件**：原封不动，继续负责 ClawBot / iLink 的扫码、长轮询、消息和媒体。

这样既不用 fork 腾讯插件，也不用把微信协议重写一遍。

---

## 功能特性

- **Web 内扫码登录**：DSH → Plugins → `dsh-clawbot` → 微信 ClawBot → 扫码登录
- **每个微信用户独立持久 Session**：重启 DSH 后自动 resume
- **文本消息收发**：DSH 最终 assistant 回复自动发回微信
- **会话管理**：`/new`、`/list`、`/use`、`/title`
- **模型切换**：`/model` 查看和切换当前会话模型
- **目标模式**：`/goal <目标>` 通过指令直接创建 DSH 目标并自动继续执行，不依赖模型调用 `create_goal`；每轮结果自动推回微信
- **工作区管理**：`/workspace` 列出、切换、创建 DSH 工作区
- **微信内审批**：工具需要权限时推送到微信，显示工具、命令/文件路径和原因，自动脱敏 token；回复 `/approve` 允许一次或 `/reject` 拒绝，多个审批按聊天排队
- **图片/文件入站**：图片走 DSH attachment（需要视觉模型），其他文件走附件路径
- **图片/文件/视频出站**：`/send` 发送工作区内文件；模型调用 `present` 声明的交付物在回合结束后自动发到微信
- **语音出站**：`/voice` 把工作区内的 `.silk`、`.wav` 等音频转成微信原生语音条；其他格式有 `ffmpeg` 时自动转码，转换或协议发送失败时降级为普通音频文件
- **登录白名单**：扫码者自动写入 allowlist，其他微信用户默认拒绝
- **多账号隔离**：按 `accountId + userId` 隔离会话
- **不阻塞长轮询**：Agent 在后台运行，微信通道可以继续收消息、处理审批和多用户请求

---

## 架构原理

```text
微信 App
  ↕  微信服务器
ClawBot / 腾讯 iLink 后端（ilinkai.weixin.qq.com）
  ↕  HTTPS / ilink/bot/*
腾讯插件 @tencent-weixin/openclaw-weixin（不修改）
  ↕  OpenClaw ChannelPlugin / channelRuntime 契约
兼容层（src/compat，OpenClaw host shim）
  ↕  WeixinTransport（InboundMessage / OutboundReply）
A 适配器（src/adapter.js，DSH bundle）
  ↕  ctx.agents / session/event / attachments / approval
DeepSeek Harness（DSH）
```

### 三层职责

| 层 | 只负责 | 不需要知道 |
|---|---|---|
| **A 适配器** | 微信用户 → DSH Session；`agent.followup()`；监听 `session/event` 取最终回复；附件、审批、指令、模型、工作区 | OpenClaw、iLink 协议 |
| **兼容层** | 让腾讯插件以为自己在 OpenClaw 里跑：`openclaw/plugin-sdk/*` 桩 + `channelRuntime`（routing/session/reply/media/commands） | DSH Agent 内部 |
| **腾讯插件** | 扫码、`getUpdates` 长轮询、`context_token`、CDN AES 加解密、语音、引用、重试、发送 | DSH |

### 入站链路

```text
微信消息
  → 腾讯插件 getUpdates
  → 兼容层 dispatchReplyFromConfig
  → A 适配器 handleInbound
  → agent.followup(createUserMessage(...))
  → DSH Agent 运行
```

### 出站链路

```text
DSH assistant/message
  → A 适配器取最终文本
  → 兼容层 dispatcher.deliver(payload)
  → 腾讯插件 sendMessage
  → iLink / 微信
```

### 兼容层到底补了什么

腾讯插件实际只用到 7 个 `openclaw/plugin-sdk/*` 子路径：

```text
account-id
config-mutation
temp-path
channel-ingress-runtime
channel-outbound
hook-runtime
plugin-runtime
```

以及约 10 个 `channelRuntime` 方法：

```text
media.saveMediaBuffer
routing.resolveAgentRoute
session.resolveStorePath
session.recordInboundSession
reply.finalizeInboundContext
reply.resolveHumanDelayConfig
reply.createReplyDispatcherWithTyping
reply.withReplyDispatcher
reply.dispatchReplyFromConfig
commands.shouldComputeCommandAuthorized
```

兼容层把这些接口接到 DSH 的 Session / Agent / attachment / approval 上，但不实现任何微信协议。

### 为什么不用 fork 腾讯插件

因为 fork 之后要自己维护：CDN AES-128-ECB、`context_token`、SILK 语音、引用缓存、`-14` 暂停、24 小时 token、限流重试、扫码状态机。腾讯插件已经把这些做完了，兼容层只需要补宿主接口，升级成本最低。

---

## 兼容性

| 组件 | 要求 |
|---|---|
| DSH | `>=0.2.2-rc.1 <0.4.0` |
| Node.js | `>=24.9.0` |
| 腾讯插件 | `@tencent-weixin/openclaw-weixin@2.4.10` |
| 微信 | 能进入「我 → 设置 → 插件 → ClawBot」，建议 iOS 8.0.70+ / 新版 Android |

已在 DSH `0.2.2-rc.1` 和 `0.2.2-rc.3` 上实际启动验证：bundle、Web 卡片、二维码登录 API 均可用。

---

## 安装

### 前置条件

- 已安装 DSH，`dsh --version` 正常
- Node.js >= 24.9
- 已安装 pnpm
- 微信客户端能看到 ClawBot 入口

### 安装步骤

```sh
git clone git@github.com:yunhai89/dsh-clawbot.git
cd dsh-clawbot
pnpm install
dsh plugin --profile web add file:"$PWD"
```

`dsh plugin add` 会自动把 `dsh-clawbot` 加进 profile 的 `dsh.profile.bundles`。然后重启：

```sh
dsh web
```

如果插件列表里看到了但没启用，打开 DSH Web → **Plugins** → **dsh-clawbot** → 打开开关。

> 本地 `file:` 安装时，插件的依赖由它自己的 `node_modules` 提供；所以先执行 `pnpm install`。新增源码文件后，重新执行一次 `dsh plugin --profile web add file:"$PWD"` 或把新文件同步到 profile 的 `node_modules/dsh-clawbot/`。

---

## 首次扫码登录

1. 打开 DSH Web（默认 `http://127.0.0.1:3080`）
2. 左侧 **Plugins**
3. 已安装插件里点 **dsh-clawbot**
4. 找到 **微信 ClawBot** 卡片
5. 点 **扫码登录**
6. 手机微信扫码并确认
7. 先在微信里发：

```text
/whoami
```

`/whoami` 不经过模型，能收到回复就说明整条通道已经通了。之后可以发普通消息测试 Agent。

二维码约 5 分钟有效；过期就点「刷新二维码」。如果手机要求数字验证码，卡片里会显示输入框。

---

## 微信内指令

| 指令 | 作用 |
|---|---|
| `/new [标题]` | 开启新会话；默认继承当前模型和工作区 |
| `/list` | 列出该微信用户的全部会话，`*` 标记当前会话 |
| `/use <序号\|id\|标题>` | 进入指定会话，之后消息发到该会话 |
| `/title <标题>` | 重命名当前会话 |
| `/workspace` / `/ws` | 列出已登记工作区，`*` 标记当前工作区 |
| `/workspace <序号\|标题\|路径>` | 切换到该工作区，并在其中开启新会话（旧会话保留） |
| `/workspace new <路径> [标题]` | 创建目录、登记工作区，并在其中开启新会话 |
| `/workspace here` | 查看当前会话的工作区 |
| `/model` | 查看当前模型和可用模型列表 |
| `/model <序号\|provider/model\|default>` | 切换当前会话模型；`default` 恢复默认模型 |
| `/goal` | 查看当前目标、状态、轮次和自动继续状态 |
| `/goal <目标>` | 直接创建目标并启用自动继续；同名别名 `/target`、`/目标` |
| `/goal edit <目标>` | 修改当前目标 |
| `/goal pause` / `/goal resume` | 暂停 / 恢复自动继续 |
| `/goal complete` | 标记目标完成 |
| `/goal block <原因>` | 把当前目标标记为阻塞 |
| `/goal rounds <轮数>` | 修改自动继续轮数上限 |
| `/goal clear` | 清除当前目标记录 |
| `/status` | 查看账号、当前会话、模型、Agent 状态 |
| `/stop` | 停止当前任务 |
| `/whoami` | 查看账号 / 用户 / 当前会话 id |
| `/send <路径> [说明]` | 发送当前工作区内图片/文件/视频（realpath 防越界，支持带引号路径） |
| `/voice <路径> [说明]` | 把工作区内音频转成微信原生语音条；失败时降级为音频文件 |
| `/approve` / `/reject` | 同意 / 拒绝当前工具审批 |
| `/help` | 显示帮助 |

腾讯插件自带的 `/echo`、`/toggle-debug` 仍然优先在插件层处理。

### 指令示例

```text
/list
/model
/new 工作
/workspace new "/root/projects/demo" 演示项目
/workspace
/use 1
/title 项目 A
/model 1
/status
/goal 修复所有失败的测试并提交
/goal
```

### 目标模式

微信里的普通消息会以 `source.kind = clawbot` 进入 DSH，因此模型不能通过 `create_goal` 工具自己创建目标——该工具只接受顶层会话中的直接人类消息。`/goal` 指令绕开模型，直接调用 `ctx.goals.create()`，所以能稳定创建目标：

```text
/goal 修复所有失败的测试并提交
```

创建后 DSH 的 goal-round-driver 会自动继续执行。每一轮结束、出错或完成时，结果都会以「【目标 · 第 N 轮】」推回微信；如果模型额度不足等错误导致自动继续被暂停，消息里会提示发送 `/goal resume` 恢复。

### 出站图片、文件、视频和语音

三种发送方式：

```text
/send 报告.pdf 这是最终报告
/send "output/屏幕截图.png"
/voice voice.mp3 听一下这段
```

- `/send` 按扩展名自动走腾讯插件的图片、视频或文件消息；路径必须在当前工作区内。
- `/voice` 走原生微信语音消息（`VOICE` item）：`.silk` 直接使用；`.wav` 由内置 `silk-wasm` 编码为 16 kHz SILK；`.mp3`、`.ogg`、`.m4a` 等格式需要系统安装 `ffmpeg` 才能转码。编码或协议发送失败时自动降级成音频文件发送。
- 模型在回合内调用 `present` 声明文件时，回合结束后会自动通过微信发送。工作区内的音频会优先尝试语音；其他文件按图片/视频/文件发送。
- 目前没有 TTS：语音发送的是已有音频文件，不会把文字自动合成语音。
- 微信 iLink 对第三方机器人出站语音条存在客户端侧限制，个别账号可能出现 API 返回成功但微信不渲染语音条的情况；需要确保收到音频时请用 `/send` 发送音频文件。

### 会话与工作区的持久化

会话列表、标题、模型和工作区选择持久化在：

```text
$DSH_HOME/clawbot/conversations.json
```

DSH Session 本身仍然保存完整历史。切换会话不会删除旧会话，随时可以 `/use` 回来。

DSH 的 sandbox / 写权限根目录绑定 Session 创建时的 `cwd`，所以 `/workspace` 切换采用「在目标工作区开一个新会话并切过去」，不是原地改已有会话的目录。旧会话和它的工作区仍然保留。

---

## 配置

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里按行 id 覆盖：

```yaml
- id: clawbot
  name: dsh-clawbot
  config:
    stateDir: /root/.dsh/clawbot
    workspace: /root/.dsh/clawbot/workspace
    workspaceRoots: []
    agentPreset: standard
    permissionPreset: workspace-write
    provider: deepseek-official
    model: deepseek-flash
    reasoningEffort: max
    maxTokens: 8192
    allowUsers: []
    allowAllUsers: false
    approvalTimeoutMs: 300000
    idleAgentTimeoutMs: 1800000
    replyProgress: true
    goalProgress: true
    autoStart: true
    debug: false
    botAgent: DSH-ClawBot/0.1
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `stateDir` | `$DSH_HOME/clawbot` | 账号 token、allowlist、媒体、会话映射的目录 |
| `workspace` | `$DSH_HOME/clawbot/workspace` | 默认工作区 |
| `workspaceRoots` | `[]` | 允许切换/创建的工作区根目录；空表示不限制。建议生产环境设为项目根目录 |
| `agentPreset` | `standard` | DSH Agent preset |
| `permissionPreset` | `workspace-write` | 权限预设；`ask` 的工具审批会转发到微信 |
| `provider` / `model` | 当前默认模型 | 不填时使用 `agent-default-model` |
| `reasoningEffort` | 模型默认 | 推理强度 |
| `maxTokens` | 模型默认 | 单次输出上限 |
| `allowUsers` | `[]` | 额外微信用户白名单；空表示使用扫码者 allowlist |
| `allowAllUsers` | `false` | **危险**：允许 allowlist 为空时接收所有微信用户；默认 fail-closed |
| `approvalTimeoutMs` | `300000` | 微信审批等待时间，超时按拒绝处理 |
| `idleAgentTimeoutMs` | `1800000` | 空闲 Agent 回收时间；`0` 关闭。会话历史保留，下条消息自动 resume |
| `replyProgress` | `true` | 是否允许腾讯插件的进度消息能力 |
| `goalProgress` | `true` | 是否把目标模式每一轮的执行结果推回微信；关闭后目标仍会运行，但微信不显示中间轮次 |
| `autoStart` | `true` | 插件加载时自动启动已登录账号 |
| `debug` | `false` | 开启 `/api/dsh-clawbot/debug/inbound` 本地调试接口 |
| `botAgent` | `DSH-ClawBot/0.1` | iLink 的 `bot_agent` 观测标识 |

状态目录里包含：

```text
$DSH_HOME/clawbot/
  accounts.json                 # 已登录账号索引
  accounts/<id>.json            # bot token（600）
  credentials/                  # allowlist
  conversations.json            # 会话/标题/模型/工作区
  session-map.json              # 旧版迁移来源（保留）
  media/                        # 入站/出站媒体
  sessions/                     # 兼容层路径占位
```

---

## 目录结构

```text
dsh-clawbot/
├── src/
│   ├── index.js                # DSH bundle 入口：A 适配器 + 兼容层 + Web 路由
│   ├── adapter.js              # A 适配器：Session/Agent/指令/审批/模型/工作区
│   ├── conversations.js        # 微信会话持久化（标题、模型、工作区）
│   ├── transport.js            # WeixinTransport 消息信封
│   ├── paths.js                # DSH home / state / workspace 路径
│   ├── util.js                 # 文件、MIME、脱敏等工具
│   ├── client.js               # Web 插件卡片：二维码/状态/退出登录
│   ├── web/
│   │   └── routes.js           # /api/dsh-clawbot/* 路由
│   └── compat/
│       ├── index.js            # OpenClaw 兼容层
│       ├── plugin-api.js       # 腾讯插件深层导入的唯一入口
│       ├── login.js            # iLink 扫码登录
│       ├── openclaw-runtime.js # channelRuntime 实现
│       ├── util.js             # 兼容层工具
│       └── openclaw-shim/      # 假 openclaw 包（plugin-sdk 子路径）
├── test/
│   ├── adapter.test.js
│   ├── conversations.test.js
│   └── compat-runtime.test.js
├── cordis.patch.yml
├── package.json
└── README.md
```

---

## 开发与测试

```sh
git clone git@github.com:yunhai89/dsh-clawbot.git
cd dsh-clawbot
pnpm install
node --test test/*.test.js
```

测试覆盖：

- A 适配器的 Session 创建、最终回复提取、指令、审批
- 会话列表、标题、模型、工作区持久化
- 兼容层 `channelRuntime` 与腾讯插件 `processOneMessage` 的真实入站链路

本地联调时可以把 `debug: true` 打开，然后用：

```sh
curl -X POST http://127.0.0.1:3080/api/dsh-clawbot/debug/inbound \
  -H 'content-type: application/json' \
  -d '{"text":"你好","userId":"debug@im.wechat","accountId":"debug-account"}'
```

这个接口只允许本机同源请求，且只在 `debug: true` 时注册。

---

## 安全模型

- **DSH Connection 鉴权**：`/api/dsh-clawbot/*` 精确路由不在普通 `/api` 桥里，因此额外调用 DSH Connection 的 `requestRejection()`；未登录的本地进程也无法扫码、登出或读状态。
- **扫码者白名单（fail-closed）**：扫码成功后，扫码者的 `ilink_user_id` 自动写入 allowlist；账号没有 allowlist 且没有记录 owner 时，插件拒绝启动该账号，而不是退回“允许所有人”。
- **审批转发**：默认 `workspace-write`，越界操作需要微信 `/approve`；审批卡片会带上工具名、实际命令/文件路径和原因，并对 token、API key、password 等做脱敏；同一聊天的多个审批会排队，子 Agent 的审批会按 `parentSession` 路由回发起它的微信会话，超时按拒绝处理。
- **工作区绑定**：DSH Session 的 sandbox / 写权限根目录绑定创建时的 `cwd`；切换工作区会开新会话。可用 `workspaceRoots` 限制允许的工作区根目录。
- **状态目录权限**：`$DSH_HOME/clawbot` 为 `700`；token、allowlist、context token、会话映射、SQLite 引用缓存均为 `600`，并每 5 分钟自动校正一次。
- **SSRF 防护**：二维码轮询的 `baseUrl` 只允许腾讯 `https://*.weixin.qq.com` / `https://*.qq.com`，拒绝内网地址和带凭据 URL。
- **登出确认**：`/logout` 必须显式提交 `{"confirm":true}`，Web UI 会二次确认。
- **不要把 DSH Web 暴露到公网**：默认只监听 `127.0.0.1`；如需远程使用，走 SSH 隧道或加认证反向代理。
- **不要把 `permissionPreset` 设为 `danger-full-access`**，除非你完全信任这个微信账号。
- 微信消息走腾讯服务器，不是端到端加密；不要在聊天里发密码、token、私钥。
- 安全问题请走 [SECURITY.md](./SECURITY.md) 的私密报告渠道，不要公开提交可导致 token 泄露或命令执行的 issue。

## 性能设计

- **非阻塞长轮询**：微信消息进入后台 dispatch，Agent 运行期间通道仍能收消息、处理审批和多用户请求。
- **大文件流式写入**：超过 2 MB 的附件通过 `saveFileStream` 直接流进 DSH attachment，不在 Node 堆里整块缓存；图片单独限制 20 MB。
- **模型目录缓存**：`/model` 的 provider/model 列表缓存 60 秒，并按 provider 并行查询，单个 provider 4 秒超时。
- **会话写入合并**：`lastActiveAt` 这类高频变化 500 ms 合并一次落盘；结构性变更（新建/切换/改名/换模型）立即写。
- **空闲 Agent 回收**：默认 30 分钟无活动就 dispose Agent，Session 历史保留，下条消息自动 resume。
- **页面隐藏时暂停轮询**：Web 卡片在标签页隐藏时不再每 4 秒请求状态。

---

## 常见问题 FAQ

### 微信 ClawBot 怎么接入 DeepSeek Harness？

安装本插件，重启 DSH，在 Web 的 Plugins → dsh-clawbot → 微信 ClawBot 里扫码登录即可。之后微信里直接发消息。

### 需要安装 OpenClaw 吗？

不需要。兼容层自带一个极小的 `openclaw` 包，只实现腾讯插件用到的 `plugin-sdk` 子路径；腾讯插件照常运行，但宿主是 DSH。

### 支持哪些 DSH 版本？

`>=0.2.2-rc.1 <0.4.0`。已在 `0.2.2-rc.1` 和 `0.2.2-rc.3` 上启动验证。

### 为什么提示“与当前 DSH 不兼容”？

你的 DSH 版本低于插件声明的 `engines.dsh`。升级 DSH，或使用兼容旧版本的插件版本。当前插件最低支持 `0.2.2-rc.1`。

### 微信里怎么切换模型？

发 `/model` 看列表，再发 `/model <序号>`；也可以直接 `/model provider/model`。`/model default` 恢复默认模型。

### 微信里怎么开新对话、切换对话？

- `/new [标题]` 开新对话
- `/list` 列出对话
- `/use <序号|id|标题>` 进入指定对话

### 微信里怎么创建工作区、切换工作区？

- `/workspace` 查看
- `/workspace <序号|标题|路径>` 切换（会开新会话）
- `/workspace new <路径> [标题]` 创建并登记
- `/workspace here` 查看当前会话工作区

### 为什么切换工作区会开新会话？

DSH 的 sandbox / 写权限根目录绑定 Session 创建时的 `cwd`。为了确保新工作区的文件权限正确，切换工作区采用“在新工作区开新会话”，旧会话保留。

### 支持群聊吗？

不支持。腾讯插件当前只声明私聊能力；本适配器按单聊设计。

### 图片、语音、文件支持吗？

- 图片：会下载、解密、存入 DSH attachment；需要视觉模型才能“看见”
- 文件/视频：保存为附件
- 语音：优先使用腾讯返回的转写文本；没有转写时保存为文件

### 工具申请权限时微信里会看到什么？

会收到一条「DSH 权限申请」，包含当前会话、工具名、实际命令或文件路径、审批原因，以及 `/approve` / `/reject` 提示。命令里的 token、API key、password 等会被脱敏；同一聊天有多个审批时会排队，处理完当前审批后自动发下一个。

### 模型报 401 / MISSING_CREDENTIAL 怎么办？

这是模型 provider 的凭据问题，不是微信通道问题。去 DSH 的 Models 页重新保存 key，或在 `clawbot` 行配置可用的 `provider` / `model`。

### 为什么在对话里让 DSH 创建目标会失败？

DSH 的 `create_goal` 工具要求当前顶层 turn 中存在直接人类消息（`source.kind = user`）。微信消息由适配器以 `source.kind = clawbot` 注入，所以模型调用该工具会被拒绝。改用 `/goal <目标>` 指令即可，它直接操作 goal 服务，不需要模型和该工具。

### 任务中途失败，为什么以前只显示「已执行：...」？

旧版在收到 `turn/end` 时只检查有没有 assistant 文字，没文字就用工具名兜底，把真正的错误（例如余额不足、限流、超时）吞掉了。现在会优先返回具体错误、错误码和 HTTP 状态，并附带失败前调用过的工具列表。

### 微信里能发图片、文件、视频和语音吗？

能。手动发送用 `/send`（图片/文件/视频）或 `/voice`（语音）；模型调用 `present` 声明交付物后也会自动发送。语音只支持已有音频文件，不支持文字转语音；`.silk`/`.wav` 可直接转换，其他格式需要系统安装 `ffmpeg`。所有发送路径都限制在当前工作区内，防止模型把工作区外的敏感文件外发。

### 端口 3080 被占用 / 有两个 DSH 进程？

只保留一个 DSH `web` 进程。两个进程同时使用同一个 ClawBot token 会抢消息。用 `systemctl status dsh-web` 或 `ps aux | grep 'dsh web'` 检查。

---

## 已知限制

- 仅支持微信单聊；群聊不是腾讯插件当前声明的能力。
- 图片要模型支持视觉输入才能“看见”；纯文本模型会收到附件引用而不是图像内容。
- 语音优先使用腾讯返回的转写文本；没有转写时保存为文件。
- 二维码约 5 分钟有效；过期需要在 Web 卡片里刷新。
- 腾讯 iLink token 可能过期；过期后需要重新扫码。
- 该包依赖腾讯插件的内部 `dist/src/*` 深层导入；升级 `@tencent-weixin/openclaw-weixin` 时先跑测试。
- 本地 `file:` 安装时，新增源码文件需要重新 `dsh plugin add` 或同步到 profile 的 `node_modules/dsh-clawbot/`。

---

## 相关关键词

微信 ClawBot、微信机器人、微信 AI 助手、DeepSeek Harness、DSH 插件、DSH 微信通道、腾讯 iLink、iLink Bot API、OpenClaw、OpenClaw 插件、WeChat bot、WeChat ClawBot、AI Agent、Cordis、DeepSeek。

---

## License

[MIT](./LICENSE) © 2026 yunhai89
