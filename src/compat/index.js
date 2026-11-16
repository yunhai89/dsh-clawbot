import path from 'node:path';

import { loadPluginApi } from './plugin-api.js';
import { startQrLogin, pollQrLogin, writeBotAgentIdentity } from './login.js';
import { createChannelRuntime } from './openclaw-runtime.js';
import { ensureDir } from './util.js';
import { errorMessage } from '../transport.js';

const STOP_TIMEOUT_MS = 4_000;

/**
 * OpenClaw host compatibility layer. It embeds Tencent's unmodified Weixin
 * channel plugin and exposes the small WeixinTransport surface the A adapter
 * consumes.
 */
export class OpenClawCompat {
  constructor({ ctx, config, stateDir, log }) {
    this.ctx = ctx;
    this.config = config;
    this.stateDir = stateDir;
    this.log = log ?? (() => {});
    this.api = null;
    this.cfg = null;
    this.channelRuntime = null;
    this.handler = null;
    this.accounts = new Map();
    this.lastError = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    ensureDir(this.stateDir);

    // The plugin reads these two environment variables at call time.
    process.env.OPENCLAW_STATE_DIR = this.stateDir;
    process.env.OPENCLAW_CONFIG = path.join(this.stateDir, 'openclaw.json');
    process.env.OPENCLAW_LOG_LEVEL ??= this.config.debug ? 'DEBUG' : 'INFO';

    // Set bot_agent before the plugin's cached config reader sees openclaw.json.
    writeBotAgentIdentity(this.stateDir, this.config.botAgent || 'DSH-ClawBot/0.1');

    this.api = await loadPluginApi();

    this.cfg = {
      channels: {
        'openclaw-weixin': {
          enabled: true,
          replyProgressMessages: this.config.replyProgress !== false,
          accounts: {},
        },
      },
      session: {
        store: path.join(this.stateDir, 'sessions.json'),
      },
    };

    this.channelRuntime = createChannelRuntime({
      stateDir: this.stateDir,
      log: this.log,
      onInbound: async (message) => {
        if (!this.handler) throw new Error('clawbot: A adapter has not started');
        return this.handler(message);
      },
    });

    this.initialized = true;
    return this;
  }

  async start(handler) {
    await this.init();
    this.handler = handler;
    await this.stop({ notify: false });

    const ids = this.api.listIndexedWeixinAccountIds().filter(Boolean);
    if (ids.length === 0) {
      this.log('ClawBot: no account yet; open the Weixin card in DSH to scan the QR code');
      return this.status();
    }

    for (const accountId of ids) {
      let account;
      try {
        account = this.api.resolveWeixinAccount(this.cfg, accountId);
      } catch (error) {
        this.lastError = errorMessage(error);
        this.log(`ClawBot: cannot resolve account ${accountId}: ${this.lastError}`);
        continue;
      }
      if (!account.configured) continue;
      this.startAccount(account);
    }

    return this.status();
  }

  startAccount(account) {
    const abort = new AbortController();
    const runtimeLog = (message) => this.log(`[${account.accountId}] ${String(message)}`);
    const task = this.api.weixinPlugin.gateway
      .startAccount({
        account,
        cfg: this.cfg,
        channelRuntime: this.channelRuntime,
        abortSignal: abort.signal,
        setStatus: (snapshot) => this.updateStatus(account.accountId, snapshot),
        runtime: { log: runtimeLog, error: runtimeLog },
        log: { info: runtimeLog, error: runtimeLog },
      })
      .catch((error) => {
        this.lastError = errorMessage(error);
        this.updateStatus(account.accountId, {
          running: false,
          lastError: this.lastError,
        });
        runtimeLog(`monitor stopped: ${this.lastError}`);
      });

    this.accounts.set(account.accountId, {
      account,
      abort,
      task,
      running: true,
      lastError: null,
      lastEventAt: null,
    });
    this.log(`ClawBot: monitor started for ${account.accountId}`);
  }

  updateStatus(accountId, snapshot) {
    const entry = this.accounts.get(accountId);
    if (!entry) return;
    if (snapshot?.running === false) entry.running = false;
    if (typeof snapshot?.lastError === 'string') entry.lastError = snapshot.lastError;
    if (Number.isFinite(snapshot?.lastEventAt)) entry.lastEventAt = snapshot.lastEventAt;
  }

  async stop({ notify = true } = {}) {
    const entries = [...this.accounts.values()];
    this.accounts.clear();
    for (const entry of entries) {
      entry.abort.abort();
      await Promise.race([
        entry.task.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
      ]);
      if (notify) {
        try {
          await this.api.weixinPlugin.gateway.stopAccount({
            account: entry.account,
            cfg: this.cfg,
          });
        } catch {
          // Best-effort lifecycle notification.
        }
      }
    }
  }

  async restart() {
    if (!this.handler) return this.status();
    return this.start(this.handler);
  }

  async loginStart() {
    await this.init();
    return startQrLogin();
  }

  async loginPoll(input) {
    await this.init();
    const result = await pollQrLogin(input);
    if (result.status === 'confirmed' || result.status === 'binded_redirect') {
      await this.restart().catch((error) => {
        this.lastError = errorMessage(error);
        this.log(`ClawBot: restart after login failed: ${this.lastError}`);
      });
    }
    return result;
  }

  async send({ accountId, userId, text, mediaPath }) {
    await this.init();
    const account = this.api.resolveWeixinAccount(this.cfg, accountId);
    if (!account.configured) {
      throw new Error(`ClawBot account ${accountId} is not configured`);
    }
    const contextToken = this.api.getContextToken(account.accountId, userId);
    const opts = {
      baseUrl: account.baseUrl,
      token: account.token,
      contextToken,
      accountId: account.accountId,
    };

    if (mediaPath) {
      const result = await this.api.sendWeixinMediaFile({
        filePath: mediaPath,
        to: userId,
        text: text ?? '',
        opts,
        cdnBaseUrl: account.cdnBaseUrl,
      });
      return { messageId: String(result?.messageId ?? '') };
    }

    const result = await this.api.sendMessageWeixin({
      to: userId,
      text: text ?? '',
      opts,
    });
    return { messageId: String(result?.messageId ?? '') };
  }

  async logout() {
    await this.init();
    await this.stop();
    for (const accountId of this.api.listIndexedWeixinAccountIds()) {
      try {
        this.api.clearWeixinAccount?.(accountId);
        this.api.unregisterWeixinAccountId?.(accountId);
      } catch {
        // best-effort
      }
    }
    this.lastError = null;
  }

  status() {
    if (!this.api) {
      return {
        connected: false,
        state: 'initializing',
        accounts: [],
        lastError: this.lastError,
      };
    }
    const accounts = [];
    for (const accountId of this.api.listIndexedWeixinAccountIds()) {
      let resolved;
      try {
        resolved = this.api.resolveWeixinAccount(this.cfg, accountId);
      } catch {
        continue;
      }
      const data = this.api.loadWeixinAccount(accountId) ?? {};
      const live = this.accounts.get(accountId);
      accounts.push({
        accountId,
        userId: data.userId,
        baseUrl: resolved.baseUrl,
        configured: resolved.configured,
        running: Boolean(live?.running),
        lastError: live?.lastError ?? undefined,
        lastEventAt: live?.lastEventAt ?? undefined,
      });
    }
    const connected = accounts.some((account) => account.configured);
    return {
      connected,
      state: connected ? 'connected' : 'unauthenticated',
      accounts,
      lastError: this.lastError ?? undefined,
      version: this.api.version,
      stateDir: this.stateDir,
    };
  }
}
