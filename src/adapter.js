import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConversationStore } from './conversations.js';
import { detectImageMime, ensureDir, safeFilename } from './util.js';
import { errorMessage } from './transport.js';

const TURN_TIMEOUT_MS = 30 * 60_000;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const FILE_MAX_BYTES = 50 * 1024 * 1024;
const STREAM_THRESHOLD_BYTES = 2 * 1024 * 1024;

function textOf(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = textOf(messages[i]);
    if (text) return text;
  }
  return '';
}

function formatTurnReason(reason) {
  if (!reason || typeof reason !== 'object') return String(reason ?? 'unknown');
  if (reason.kind === 'error') {
    const message = reason.error?.message ?? reason.error ?? 'unknown error';
    const code = reason.error?.code ? ` (${reason.error.code})` : '';
    return `模型调用失败：${message}${code}`;
  }
  if (reason.kind === 'cancelled') return '本轮已取消';
  if (reason.kind === 'completed') return 'completed';
  return reason.kind ? String(reason.kind) : JSON.stringify(reason);
}

function truncateText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…（已截断）`;
}

function redactForWeChat(value) {
  return String(value ?? '')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .replace(/\b(?:sk|oc_sk|ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_-]{8,}/g, '***')
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)\s*[:=]\s*)(["']?)([^\s"',;]+)/gi,
      '$1$2***',
    );
}

function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function formatToolAction(toolName, rawArguments) {
  const parsed = parseToolArguments(rawArguments);
  const name = String(toolName ?? 'unknown');
  let action;
  if (parsed && typeof parsed === 'object') {
    if (name === 'bash' || name === 'pwsh') {
      action = parsed.command;
      if (parsed.description) action = `${action}\n说明：${parsed.description}`;
    } else if (name === 'write') {
      action = `写入文件：${parsed.path ?? '(unknown)'}`;
      if (typeof parsed.content === 'string') action += `\n内容长度：${parsed.content.length} 字符`;
    } else if (name === 'edit' || name === 'str_replace_editor') {
      action = `编辑文件：${parsed.path ?? '(unknown)'}`;
      if (typeof parsed.old_string === 'string') action += `\n替换：${parsed.old_string.length} → ${String(parsed.new_string ?? '').length} 字符`;
    } else if (name === 'read' || name === 'read_image') {
      action = `读取：${parsed.path ?? parsed.file_path ?? '(unknown)'}`;
    } else if (name === 'apply_patch') {
      action = `应用补丁：${parsed.path ?? parsed.patch?.slice?.(0, 120) ?? '(patch)'}`;
    } else if (name === 'jobs') {
      action = parsed.command ?? parsed.action ?? JSON.stringify(parsed);
    } else if (name === 'present' || name === 'message' || name === 'wechat_send') {
      action = parsed.path ?? parsed.text ?? JSON.stringify(parsed);
    } else {
      action = JSON.stringify(parsed, null, 2);
    }
  } else if (typeof rawArguments === 'string' && rawArguments.trim()) {
    action = rawArguments.trim();
  }
  return redactForWeChat(truncateText(action || '(未捕获到参数)', 1400));
}

function toolNamesOf(messages) {
  const names = new Set();
  for (const message of messages) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool-call' && block.name) names.add(block.name);
    }
  }
  return [...names];
}

async function withTimeout(promise, ms, label = 'timeout') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const space = trimmed.indexOf(' ');
  const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  const args = space === -1 ? '' : trimmed.slice(space + 1).trim();
  return { name, args };
}

async function createUserMessage(content, source) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm');
    return mod.createUserMessage({ content, source });
  } catch {
    return {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      source,
    };
  }
}

/**
 * A adapter: the only DSH-aware layer. It maps WeChat peers to DSH Sessions,
 * drives agents with durability, and converts final assistant output back into
 * transport-agnostic replies.
 */
export class WeixinAdapter {
  constructor({ ctx, config, transport, stateDir, workspace, log }) {
    this.ctx = ctx;
    this.config = config;
    this.transport = transport;
    this.stateDir = stateDir;
    this.workspace = workspace;
    this.log = log ?? (() => {});
    this.agents = new Map();
    this.turns = new Map();
    this.pendingApprovals = new Map();
    this.approvalQueues = new Map();
    this.toolCalls = new Map();
    this.disposing = new Map();
    this.started = false;
    this.unlisten = null;
    this.unlistenApproval = null;
    this.idleTimer = null;
    this.conversations = new ConversationStore({
      filePath: path.join(stateDir, 'conversations.json'),
      legacyPath: path.join(stateDir, 'session-map.json'),
      log: this.log,
    });
    this.modelCatalog = null;
    this.modelCatalogAt = 0;
    this.workspaceRoots = (Array.isArray(config.workspaceRoots) ? config.workspaceRoots : [])
      .map((root) => {
        const value = String(root);
        const expanded =
          value === '~'
            ? os.homedir()
            : value.startsWith('~/')
              ? path.join(os.homedir(), value.slice(2))
              : path.resolve(value);
        try {
          return fs.realpathSync(expanded);
        } catch {
          return expanded;
        }
      })
      .filter(Boolean);
  }

  async start() {
    if (this.started) return this.status();
    this.unlisten = this.ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event);
    });
    this.unlistenApproval = this.ctx.on('approval/request', (request, next) =>
      this.onApprovalRequest(request, next),
    );
    const idleTimeout = Number(this.config.idleAgentTimeoutMs) || 0;
    if (idleTimeout > 0) {
      this.idleTimer = setInterval(() => this.reapIdleAgents(idleTimeout), 60_000);
      this.idleTimer.unref?.();
    }
    this.started = true;
    await this.transport.start((message) => this.handleInbound(message));
    return this.status();
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    try {
      this.unlisten?.();
      this.unlistenApproval?.();
    } catch {
      // best-effort
    }
    this.unlisten = null;
    this.unlistenApproval = null;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.cancelAllApprovals();
    for (const sessionId of [...this.agents.keys()]) {
      await this.disposeAgent(sessionId).catch(() => {});
    }
    await Promise.allSettled([...this.disposing.values()]);
    for (const sessionId of [...this.turns.keys()]) {
      this.finishTurn(sessionId, 'stopped');
    }
    this.conversations.flush();
    await this.transport.stop().catch(() => {});
  }

  onSessionEvent(session, event) {
    const ours = this.agents.has(session.id);
    if (ours && event.type === 'tool/call') {
      const callId = String(event.data?.callId ?? '');
      if (callId) {
        this.toolCalls.set(callId, {
          name: event.data?.name,
          arguments: event.data?.arguments,
          time: Date.now(),
        });
        if (this.toolCalls.size > 200) {
          const oldest = [...this.toolCalls.entries()]
            .sort((a, b) => a[1].time - b[1].time)
            .slice(0, 50);
          for (const [key] of oldest) this.toolCalls.delete(key);
        }
      }
    } else if (ours && event.type === 'tool/result') {
      const callId = String(event.data?.message?.toolCallId ?? event.data?.callId ?? '');
      if (callId) this.toolCalls.delete(callId);
    }

    const turn = this.turns.get(session.id);
    if (!turn) return;
    if (event.type === 'assistant/message') {
      turn.assistant.push(event.data.message);
      return;
    }
    if (event.type === 'turn/end') {
      this.finishTurn(session.id, event.data.reason);
    }
  }

  peerKey(accountId, userId) {
    return `${accountId}\u0000${userId}`;
  }

  resolveApproval(key, outcome) {
    const current = this.pendingApprovals.get(key);
    if (!current) return false;
    this.finishApproval(current, outcome);
    return true;
  }

  finishApproval(entry, outcome, activateNext = true) {
    if (!entry || entry.done) return;
    entry.done = true;
    if (entry.timer) clearTimeout(entry.timer);
    try {
      entry.abortCleanup?.();
    } catch {
      // best-effort
    }
    if (this.pendingApprovals.get(entry.key) === entry) {
      this.pendingApprovals.delete(entry.key);
    }
    entry.resolve(outcome);
    if (activateNext) this.activateNextApproval(entry.key);
  }

  activateNextApproval(key) {
    const queue = this.approvalQueues.get(key);
    if (!queue?.length) {
      this.approvalQueues.delete(key);
      return;
    }
    const next = queue.shift();
    if (queue.length === 0) this.approvalQueues.delete(key);
    this.activateApproval(next);
  }

  cancelAllApprovals() {
    for (const current of [...this.pendingApprovals.values()]) {
      this.finishApproval(current, 'cancelled', false);
    }
    for (const queue of [...this.approvalQueues.values()]) {
      for (const entry of queue) this.finishApproval(entry, 'cancelled', false);
    }
    this.pendingApprovals.clear();
    this.approvalQueues.clear();
  }

  async sendApprovalPrompt(entry) {
    const action = formatToolAction(
      entry.request.toolName ?? entry.cachedName,
      entry.arguments,
    );
    const title = entry.conversation?.title || entry.sessionId;
    const text = [
      '【DSH 权限申请】',
      `会话：${redactForWeChat(title)}`,
      `工具：${redactForWeChat(entry.request.toolName ?? entry.cachedName ?? 'unknown')}`,
      '动作：',
      action,
      entry.request.reason
        ? `原因：${redactForWeChat(truncateText(entry.request.reason, 300))}`
        : '',
      '回复 /approve 允许一次，/reject 拒绝。',
    ]
      .filter(Boolean)
      .join('\n');
    await this.transport.send({
      accountId: entry.record.accountId,
      userId: entry.record.userId,
      text,
    });
  }

  activateApproval(entry) {
    if (entry.done) return;
    const { key, record, request } = entry;
    this.pendingApprovals.set(key, entry);

    const timeoutMs = Number(this.config.approvalTimeoutMs) > 0
      ? Number(this.config.approvalTimeoutMs)
      : 5 * 60_000;
    entry.timer = setTimeout(() => {
      this.finishApproval(entry, 'cancelled');
      void this.transport
        .send({
          accountId: record.accountId,
          userId: record.userId,
          text: '⏱ 权限申请已超时，已按拒绝处理。',
        })
        .catch(() => {});
    }, timeoutMs);
    entry.timer.unref?.();

    const onAbort = () => this.finishApproval(entry, 'cancelled');
    request.signal?.addEventListener?.('abort', onAbort, { once: true });
    entry.abortCleanup = () => request.signal?.removeEventListener?.('abort', onAbort);

    void this.sendApprovalPrompt(entry).catch((error) => {
      this.log(`approval prompt failed: ${errorMessage(error)}`);
      this.finishApproval(entry, 'cancelled');
    });
  }

  async onApprovalRequest(request, next) {
    const sessionId = String(request?.agent?.id ?? '');
    let record = this.agents.get(sessionId);
    let conversation;
    if (record) {
      conversation = record.conversation;
    } else {
      const found = this.conversations.findBySessionId(sessionId);
      if (found) {
        record = {
          accountId: found.accountId,
          userId: found.userId,
          sessionId,
        };
        conversation = found.conversation;
      }
    }
    if (!record?.accountId || !record?.userId) return next();

    const key = this.peerKey(record.accountId, record.userId);
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const cached = request.callId ? this.toolCalls.get(String(request.callId)) : undefined;
    const entry = {
      key,
      request,
      next,
      record,
      conversation,
      sessionId,
      resolve,
      arguments: cached?.arguments,
      cachedName: cached?.name,
      done: false,
      timer: null,
      abortCleanup: null,
    };

    if (request.signal?.aborted) {
      entry.done = true;
      resolve('cancelled');
      return promise;
    }

    if (this.pendingApprovals.has(key)) {
      const queue = this.approvalQueues.get(key) ?? [];
      const firstQueued = queue.length === 0;
      queue.push(entry);
      this.approvalQueues.set(key, queue);
      if (firstQueued) {
        void this.transport
          .send({
            accountId: record.accountId,
            userId: record.userId,
            text: `当前审批处理完后，还有权限申请在排队（共 ${queue.length} 个）。`,
          })
          .catch(() => {});
      }
      return promise;
    }

    this.activateApproval(entry);
    return promise;
  }

  handleApprovalReply(key, text) {
    const value = String(text ?? '').trim().toLowerCase();
    const approve = new Set(['/approve', 'approve', '同意', 'yes']);
    const reject = new Set(['/reject', 'reject', '拒绝', 'no']);
    if (!approve.has(value) && !reject.has(value)) {
      return { text: '当前有操作等待审批，请回复 /approve 允许一次，或 /reject 拒绝。' };
    }
    const queued = this.approvalQueues.get(key)?.length ?? 0;
    this.resolveApproval(key, approve.has(value) ? 'allowed-once' : 'rejected');
    return {
      text: `${approve.has(value) ? '已允许这一次操作。' : '已拒绝这次操作。'}${
        queued > 0 ? `\n还有 ${queued} 个权限申请排队。` : ''
      }`,
    };
  }

  beginTurn(sessionId) {
    this.finishTurn(sessionId, 'replaced');
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const turn = {
      assistant: [],
      resolve,
      timer: setTimeout(() => this.finishTurn(sessionId, 'timeout'), TURN_TIMEOUT_MS),
    };
    turn.timer.unref?.();
    this.turns.set(sessionId, { ...turn, promise });
    return this.turns.get(sessionId);
  }

  finishTurn(sessionId, reason) {
    const turn = this.turns.get(sessionId);
    if (!turn) return;
    this.turns.delete(sessionId);
    clearTimeout(turn.timer);
    turn.resolve({ assistant: turn.assistant, reason });
  }

  currentConversation(accountId, userId) {
    return this.conversations.current(accountId, userId);
  }

  sessionIdForPeer(accountId, userId) {
    return this.currentConversation(accountId, userId).id;
  }

  newConversation(accountId, userId, title) {
    return this.conversations.create(accountId, userId, title);
  }

  modelLabel(selection) {
    if (!selection?.provider || !selection?.model) return '默认';
    return `${selection.provider}/${selection.model}`;
  }

  resolveAgentOptions(selection) {
    if (selection?.provider && selection?.model) {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        ...(Number.isFinite(selection.maxTokens) && selection.maxTokens > 0
          ? { maxTokens: selection.maxTokens }
          : {}),
      };
    }
    const { provider, model, reasoningEffort, maxTokens } = this.config;
    if (provider && model) {
      return {
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
      };
    }
    const defaults = this.ctx.get('agentDefaultModel');
    const value = defaults?.currentSelection?.();
    if (value?.provider && value?.model) return value;
    throw new Error(
      'ClawBot: no model route. Set provider/model in the clawbot row or configure agent-default-model.',
    );
  }

  defaultModel() {
    try {
      return this.resolveAgentOptions();
    } catch {
      return undefined;
    }
  }

  currentModel(record, conversation) {
    try {
      const live = record?.agent?.model?.current?.();
      if (live?.provider && live?.model) return live;
    } catch {
      // fall through to the conversation default
    }
    return conversation?.model ?? this.defaultModel();
  }

  renameSessionTitle(record, conversation) {
    if (!record) return;
    const titles = this.ctx.get('sessionTitle');
    try {
      titles?.rename?.(record.agent.session, `微信 · ${conversation.title}`);
    } catch {
      // optional
    }
  }

  async listAvailableModels() {
    if (this.modelCatalog && Date.now() - this.modelCatalogAt < 60_000) {
      return this.modelCatalog;
    }
    const llm = this.ctx.get('llm');
    if (!llm?.listProviders || !llm?.listModels) return [];
    const groups = await Promise.all(
      llm.listProviders().map(async (provider) => {
        let models = [];
        try {
          models = await withTimeout(llm.listModels(provider.id), 4_000, 'model list timeout');
        } catch {
          models = [];
        }
        if (!Array.isArray(models)) models = [];
        return models.map((model) => ({
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          name: model.name || model.id,
        }));
      }),
    );
    const items = groups.flat();
    this.modelCatalog = items;
    this.modelCatalogAt = Date.now();
    return items;
  }

  async formatModelList(accountId, userId, conversation) {
    const record = this.agents.get(conversation.id);
    const current = this.currentModel(record, conversation);
    const fallback = this.defaultModel();
    const catalog = await this.listAvailableModels();
    const lines = [
      `当前模型：${this.modelLabel(current)}`,
      `默认模型：${this.modelLabel(fallback)}`,
      '',
      '可用模型：',
    ];
    const limit = 40;
    catalog.slice(0, limit).forEach((item, index) => {
      const mark = current?.provider === item.provider && current?.model === item.model ? '*' : ' ';
      lines.push(`${mark}${index + 1}. ${item.provider}/${item.model} — ${item.name}`);
    });
    if (catalog.length > limit) {
      lines.push(`…还有 ${catalog.length - limit} 个，直接用 /model provider/model 指定。`);
    }
    if (catalog.length === 0) {
      lines.push('没有枚举到模型，直接用 /model provider/model 指定。');
    }
    lines.push('', '发送 /model <序号> 或 /model provider/model 切换。');
    return lines.join('\n');
  }

  async switchModel(accountId, userId, args) {
    const conversation = this.currentConversation(accountId, userId);
    if (!args) return { text: await this.formatModelList(accountId, userId, conversation) };

    const record = this.agents.get(conversation.id);
    let selection;
    if (args.toLowerCase() === 'default' || args.toLowerCase() === 'auto') {
      selection = this.defaultModel();
      if (!selection) return { text: '没有可用的默认模型。' };
    } else {
      const catalog = await this.listAvailableModels();
      const raw = args.trim();
      let entry;
      if (/^\d+$/.test(raw)) {
        entry = catalog[Number(raw) - 1];
      } else {
        entry =
          catalog.find((item) => `${item.provider}/${item.model}` === raw) ??
          catalog.find((item) => item.model === raw);
        if (!entry && raw.includes('/')) {
          const slash = raw.indexOf('/');
          entry = {
            provider: raw.slice(0, slash),
            model: raw.slice(slash + 1),
            name: raw.slice(slash + 1),
          };
        }
      }
      if (!entry?.provider || !entry?.model) {
        return {
          text: `没有找到模型：${raw}\n先发 /model 看列表，或直接用 /model provider/model。`,
        };
      }
      const llm = this.ctx.get('llm');
      if (llm?.resolveModelInfo) {
        try {
          await withTimeout(llm.resolveModelInfo(entry.provider, entry.model), 5_000, 'model check timeout');
        } catch (error) {
          return { text: `模型不可用：${entry.provider}/${entry.model}\n${errorMessage(error)}` };
        }
      }
      selection = { provider: entry.provider, model: entry.model };
    }

    this.conversations.setModel(accountId, userId, selection);
    if (record?.agent?.model?.select) {
      try {
        record.agent.model.select(selection);
      } catch (error) {
        return {
          text: `已记录模型 ${this.modelLabel(selection)}，但当前会话切换失败：${errorMessage(error)}`,
        };
      }
    }
    return {
      text: `已切换模型：${this.modelLabel(selection)}\n会话：${conversation.title}`,
    };
  }

  formatConversationList(accountId, userId) {
    const list = this.conversations.list(accountId, userId);
    const lines = ['微信会话：'];
    const limit = 30;
    for (const conversation of list.slice(0, limit)) {
      const record = this.agents.get(conversation.id);
      const model = this.modelLabel(this.currentModel(record, conversation));
      const marker = conversation.current ? '*' : ' ';
      const state = record ? record.agent.status : '未加载';
      const workspace = this.currentWorkspace(conversation);
      lines.push(
        `${marker}${conversation.index}. ${conversation.title}`,
        `   ${conversation.id} · ${model} · ${state} · ${path.basename(workspace)}`,
      );
    }
    if (list.length > limit) {
      lines.push(`…还有 ${list.length - limit} 个会话，直接用 /use <会话 id> 进入。`);
    }
    lines.push('', '发送 /use <序号> 进入指定会话，/new [标题] 新建会话。');
    return lines.join('\n');
  }

  expandPath(raw, base = this.workspace) {
    let value = String(raw ?? '').trim();
    if (!value) throw new Error('路径为空');
    if (value === '~') value = os.homedir();
    else if (value.startsWith('~/')) value = path.join(os.homedir(), value.slice(2));
    if (!path.isAbsolute(value)) value = path.resolve(base, value);
    return value;
  }

  assertWorkspaceAllowed(real) {
    if (this.workspaceRoots.length === 0) return real;
    const allowed = this.workspaceRoots.some(
      (root) => real === root || real.startsWith(`${root}${path.sep}`),
    );
    if (!allowed) {
      throw new Error(`工作区不在允许的 workspaceRoots 内：${real}`);
    }
    return real;
  }

  assertWorkspacePathLexical(candidate) {
    if (this.workspaceRoots.length === 0) return candidate;
    const normalized = path.resolve(candidate);
    const allowed = this.workspaceRoots.some(
      (root) => normalized === root || normalized.startsWith(`${root}${path.sep}`),
    );
    if (!allowed) {
      throw new Error(`工作区不在允许的 workspaceRoots 内：${normalized}`);
    }
    return normalized;
  }

  async canonicalDirectory(raw, { create = false, base = this.workspace } = {}) {
    const candidate = this.assertWorkspacePathLexical(this.expandPath(raw, base));
    if (create) await fs.promises.mkdir(candidate, { recursive: true });
    const real = await fs.promises.realpath(candidate);
    const stat = await fs.promises.stat(real);
    if (!stat.isDirectory()) throw new Error(`不是目录：${real}`);
    return this.assertWorkspaceAllowed(real);
  }

  async ensureWorkspace(target) {
    const cwd = await this.canonicalDirectory(target || this.workspace, { create: true });
    ensureDir(cwd);
    return cwd;
  }

  listRegisteredWorkspaces() {
    const registry = this.ctx.get('workspaceRegistry');
    try {
      return registry?.list?.() ?? [];
    } catch {
      return [];
    }
  }

  currentWorkspace(conversation) {
    return conversation?.workspace || this.workspace;
  }

  async createWorkspaceRegistration(rawPath, title, base = this.workspace) {
    const real = await this.canonicalDirectory(rawPath, { create: true, base });
    const registry = this.ctx.get('workspaceRegistry');
    if (!registry?.create) return { path: real, title: title || path.basename(real), registered: false };
    const workspace = await registry.create(real, title || path.basename(real));
    if (title && workspace.title !== title) {
      try {
        await workspace.setTitle(title);
      } catch {
        // best-effort
      }
    }
    return { path: workspace.path, title: workspace.title, registered: true, workspace };
  }

  async resolveWorkspaceTarget(selector, { create = false, title, base = this.workspace } = {}) {
    const raw = String(selector ?? '').trim();
    const registered = this.listRegisteredWorkspaces();
    if (/^\d+$/.test(raw)) {
      const workspace = registered[Number(raw) - 1];
      if (!workspace) throw new Error(`没有第 ${raw} 个工作区`);
      return { path: workspace.path, title: workspace.title, registered: true, workspace };
    }
    if (raw) {
      const byTitle = registered.find(
        (workspace) => String(workspace.title).toLowerCase() === raw.toLowerCase(),
      );
      if (byTitle) {
        return { path: byTitle.path, title: byTitle.title, registered: true, workspace: byTitle };
      }
    }
    if (create) return this.createWorkspaceRegistration(raw, title, base);
    const real = await this.canonicalDirectory(raw, { create: false, base });
    const existing = registered.find((workspace) => workspace.path === real);
    if (existing) {
      return { path: existing.path, title: existing.title, registered: true, workspace: existing };
    }
    return { path: real, title: path.basename(real), registered: false };
  }

  formatWorkspaceList(accountId, userId) {
    const conversation = this.currentConversation(accountId, userId);
    const current = this.currentWorkspace(conversation);
    const workspaces = this.listRegisteredWorkspaces();
    const lines = [`当前工作区：${current}`, '', '已登记工作区：'];
    if (workspaces.length === 0) {
      lines.push('（暂无已登记工作区）');
    } else {
      workspaces.forEach((workspace, index) => {
        const mark = workspace.path === current ? '*' : ' ';
        const count = workspace.sessionIds?.length ?? 0;
        lines.push(`${mark}${index + 1}. ${workspace.title} — ${workspace.path} (${count} 个会话)`);
      });
    }
    lines.push(
      '',
      '发送 /workspace <序号|标题|路径> 切换工作区（会开启该工作区的新会话）。',
      '/workspace new <路径> [标题] — 创建并登记新工作区',
      '/workspace here — 查看当前工作区',
    );
    return lines.join('\n');
  }

  async switchWorkspace(accountId, userId, target) {
    const conversation = this.currentConversation(accountId, userId);
    if (conversation.workspace === target.path) {
      return {
        text: `已经在工作区：${target.title || path.basename(target.path)}\n${target.path}`,
      };
    }
    const old = this.agents.get(conversation.id);
    const inheritedModel = this.currentModel(old, conversation);
    this.finishTurn(conversation.id, 'switched');
    if (old) await this.disposeAgent(conversation.id).catch(() => {});
    const created = this.newConversation(
      accountId,
      userId,
      target.title || path.basename(target.path),
    );
    this.conversations.setWorkspace(accountId, userId, target.path);
    created.workspace = target.path;
    if (inheritedModel?.provider && inheritedModel?.model) {
      this.conversations.setModel(accountId, userId, inheritedModel);
      created.model = inheritedModel;
    }
    const index = this.conversations.list(accountId, userId).find((item) => item.id === created.id)?.index;
    return {
      text: [
        `已创建工作区会话 #${index}：${created.title}`,
        `工作区：${target.path}`,
        '旧会话已保留，可用 /list 查看并用 /use 切回。',
      ].join('\n'),
    };
  }

  async createAgent({ sessionId, accountId, userId, conversation }) {
    const cwd = await this.ensureWorkspace(conversation?.workspace || this.workspace);
    const presets = this.ctx.get('agentPresets');
    let preset;
    let scope;
    if (presets) {
      preset = await presets.resolve(this.config.agentPreset || 'standard');
      scope = await presets.acquireScope(preset.id);
    }
    try {
      const setup = async (agentCtx) => {
        if (presets && preset) await presets.mount(agentCtx, preset.id);
      };
      const handle = await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd,
          ...(preset ? { agentPreset: preset.id } : {}),
        },
        agentOptions: this.resolveAgentOptions(conversation?.model),
        setup,
      });

      const permissions = this.ctx.get('permissionPresets');
      permissions?.set?.(handle.agent.session, this.config.permissionPreset || 'workspace-write');

      const workspaces = this.ctx.get('workspaceRegistry');
      if (workspaces) {
        try {
          const ws = await workspaces.create(cwd);
          await ws.attachSession(sessionId);
        } catch {
          // The Web workspace listing is optional; the session still runs.
        }
      }

      const titles = this.ctx.get('sessionTitle');
      try {
        titles?.rename?.(handle.agent.session, `微信 · ${conversation?.title || userId}`);
      } catch {
        // title generation is optional
      }

      const record = {
        agent: handle.agent,
        handle,
        sessionId,
        accountId,
        userId,
        conversation,
        lastUsedAt: Date.now(),
      };
      this.agents.set(sessionId, record);
      return record;
    } finally {
      try {
        await scope?.[Symbol.asyncDispose]?.();
      } catch {
        // best-effort
      }
    }
  }

  async resumeAgent(sessionId, accountId, userId, conversation) {
    const handle = await this.ctx.agents.resume({ resumeSessionId: sessionId });
    const record = {
      agent: handle.agent,
      handle,
      sessionId,
      accountId,
      userId,
      conversation,
      lastUsedAt: Date.now(),
    };
    this.agents.set(sessionId, record);
    if (conversation?.model && handle.agent.model?.select) {
      try {
        handle.agent.model.select(conversation.model);
      } catch (error) {
        this.log(`restore model for ${sessionId} failed: ${errorMessage(error)}`);
      }
    }
    if (conversation?.workspace) {
      const wd = this.ctx.get('workingDirectory');
      try {
        const current = wd?.get?.(handle.agent.session);
        if (current !== conversation.workspace) {
          await wd?.set?.(handle.agent, conversation.workspace);
        }
      } catch (error) {
        this.log(`restore workspace for ${sessionId} failed: ${errorMessage(error)}`);
      }
    }
    const titles = this.ctx.get('sessionTitle');
    try {
      titles?.rename?.(handle.agent.session, `微信 · ${conversation?.title || userId}`);
    } catch {
      // optional
    }
    return record;
  }

  async ensureAgent(message) {
    const conversation = this.currentConversation(message.accountId, message.userId);
    const sessionId = conversation.id;
    const pendingDispose = this.disposing.get(sessionId);
    if (pendingDispose) {
      await pendingDispose.catch(() => {});
    }
    const existing = this.agents.get(sessionId);
    if (existing) {
      existing.conversation = conversation;
      existing.lastUsedAt = Date.now();
      return existing;
    }

    const live = this.ctx.agents.get(sessionId);
    if (live) {
      const record = {
        agent: live,
        handle: null,
        sessionId,
        accountId: message.accountId,
        userId: message.userId,
        conversation,
        lastUsedAt: Date.now(),
      };
      this.agents.set(sessionId, record);
      return record;
    }

    try {
      return await this.resumeAgent(sessionId, message.accountId, message.userId, conversation);
    } catch (error) {
      this.log(`resume ${sessionId} failed, creating a fresh session: ${errorMessage(error)}`);
    }

    try {
      return await this.createAgent({
        sessionId,
        accountId: message.accountId,
        userId: message.userId,
        conversation,
      });
    } catch (error) {
      this.log(`create ${sessionId} failed, replacing identity: ${errorMessage(error)}`);
      const fresh = this.newConversation(message.accountId, message.userId);
      return this.createAgent({
        sessionId: fresh.id,
        accountId: message.accountId,
        userId: message.userId,
        conversation: fresh,
      });
    }
  }

  reapIdleAgents(idleTimeoutMs) {
    const cutoff = Date.now() - idleTimeoutMs;
    for (const [sessionId, record] of this.agents) {
      if (this.turns.has(sessionId)) continue;
      if (record.agent.status !== 'idle') continue;
      const lastUsedAt = record.lastUsedAt ?? 0;
      if (lastUsedAt > cutoff) continue;
      this.log(`reaping idle agent ${sessionId}`);
      void this.disposeAgent(sessionId).catch((error) => {
        this.log(`idle agent dispose failed for ${sessionId}: ${errorMessage(error)}`);
      });
    }
  }

  async disposeAgent(sessionId) {
    const pending = this.disposing.get(sessionId);
    if (pending) return pending;
    const record = this.agents.get(sessionId);
    if (!record) return;
    this.agents.delete(sessionId);
    const task = (async () => {
      try {
        if (record.handle) {
          await record.handle.dispose();
        } else {
          record.agent.cancel?.({ kind: 'user' });
        }
      } finally {
        this.disposing.delete(sessionId);
      }
    })();
    this.disposing.set(sessionId, task);
    return task;
  }

  async buildContent(message) {
    const content = [];
    const quote = message.replyTo?.text?.trim();
    const text = String(message.text ?? '').trim();
    const prefix = quote ? `[引用消息]\n${quote}\n\n` : '';
    if (prefix || text) content.push({ type: 'text', text: `${prefix}${text}`.trim() });

    const attachments = this.ctx.get('attachments');
    for (const media of message.media ?? []) {
      const label = media.name || path.basename(media.path);
      let stat;
      try {
        stat = await fs.promises.stat(media.path);
      } catch {
        content.push({ type: 'text', text: `[附件读取失败: ${label}]` });
        continue;
      }
      if (!stat.isFile() || stat.size > FILE_MAX_BYTES) {
        content.push({
          type: 'text',
          text: stat.isFile()
            ? `[附件过大，未载入: ${label}, ${stat.size} bytes] ${media.path}`
            : `[附件不是文件: ${label}]`,
        });
        continue;
      }

      const mime = String(media.mime ?? '');
      const isImage = media.kind === 'image' || mime.startsWith('image/');

      if (isImage && attachments && stat.size <= IMAGE_MAX_BYTES) {
        try {
          const buffer = await fs.promises.readFile(media.path);
          const imageMime = detectImageMime(buffer) ?? (mime.startsWith('image/') ? mime : undefined);
          if (imageMime) {
            const admitted = await attachments.admitPromptContent([
              {
                type: 'image',
                mediaType: imageMime,
                data: buffer.toString('base64'),
                name: label,
              },
            ]);
            content.push(...admitted);
            continue;
          }
        } catch (error) {
          this.log(`image admission failed: ${errorMessage(error)}`);
        }
      }

      if (attachments) {
        try {
          const name = safeFilename(label, 'attachment');
          if (stat.size > STREAM_THRESHOLD_BYTES && typeof attachments.saveFileStream === 'function') {
            const stream = fs.createReadStream(media.path);
            const ref = await attachments.saveFileStream({ data: stream, name });
            content.push({ type: 'file', attachment: ref });
            continue;
          }
          const buffer = await fs.promises.readFile(media.path);
          const ref = await attachments.saveFile({
            data: buffer,
            name,
          });
          content.push({ type: 'file', attachment: ref });
          continue;
        } catch (error) {
          this.log(`file admission failed: ${errorMessage(error)}`);
        }
      }

      content.push({
        type: 'text',
        text: `[附件: ${label}] ${media.path}`,
      });
    }

    if (content.length === 0) content.push({ type: 'text', text: '[空消息]' });
    return content;
  }

  async handleInbound(message) {
    if (this.config.allowUsers?.length && !this.config.allowUsers.includes(message.userId)) {
      return { text: '未授权：这个微信用户不在 clawbot.allowUsers 白名单中。' };
    }

    const text = String(message.text ?? '').trim();
    const approvalKey = this.peerKey(message.accountId, message.userId);
    if (this.pendingApprovals.has(approvalKey)) {
      return this.handleApprovalReply(approvalKey, text);
    }

    const command = parseCommand(text);
    if (command) {
      return this.handleCommand(message, command);
    }

    const beforeTitle = this.currentConversation(message.accountId, message.userId).title;
    const conversation = this.conversations.maybeTitle(message.accountId, message.userId, text);
    if (conversation.title !== beforeTitle) {
      this.renameSessionTitle(this.agents.get(conversation.id), conversation);
    }
    this.conversations.touch(message.accountId, message.userId);

    const record = await this.ensureAgent(message);
    record.conversation = conversation;
    record.lastUsedAt = Date.now();
    await record.agent.whenIdle();

    const turn = this.beginTurn(record.sessionId);
    try {
      const content = await this.buildContent(message);
      const userMessage = await createUserMessage(content, {
        kind: 'clawbot',
        accountId: message.accountId,
        userId: message.userId,
        messageId: message.messageId,
      });
      record.agent.followup(userMessage);
      const result = await turn.promise;
      record.lastUsedAt = Date.now();
      const reply = lastAssistantText(result.assistant);
      if (reply) return { text: reply };
      const tools = toolNamesOf(result.assistant);
      if (tools.length > 0) return { text: `已执行：${tools.join(', ')}` };
      return { text: `（本轮没有文字回复：${formatTurnReason(result.reason)}）` };
    } catch (error) {
      this.finishTurn(record.sessionId, 'error');
      throw error;
    }
  }

  async handleCommand(message, command) {
    const accountId = message.accountId;
    const userId = message.userId;
    switch (command.name) {
      case '/new': {
        const oldConversation = this.currentConversation(accountId, userId);
        const old = this.agents.get(oldConversation.id);
        const inheritedModel = this.currentModel(old, oldConversation);
        const inheritedWorkspace = this.currentWorkspace(oldConversation);
        this.finishTurn(oldConversation.id, 'switched');
        if (old) await this.disposeAgent(oldConversation.id).catch(() => {});
        const conversation = this.newConversation(accountId, userId, command.args || undefined);
        this.conversations.setWorkspace(accountId, userId, inheritedWorkspace);
        conversation.workspace = inheritedWorkspace;
        if (inheritedModel?.provider && inheritedModel?.model) {
          this.conversations.setModel(accountId, userId, inheritedModel);
          conversation.model = inheritedModel;
        }
        const index = this.conversations.list(accountId, userId).find((item) => item.id === conversation.id)?.index;
        return {
          text: `已开启新会话 #${index}：${conversation.title}\n${conversation.id}`,
        };
      }
      case '/list':
        return { text: this.formatConversationList(accountId, userId) };
      case '/use': {
        if (!command.args) return { text: '用法：/use <序号|会话 id|标题>' };
        const before = this.currentConversation(accountId, userId);
        const conversation = this.conversations.switch(accountId, userId, command.args);
        if (!conversation) {
          return {
            text: `没有找到会话：${command.args}\n先发 /list 查看会话列表。`,
          };
        }
        if (before.id !== conversation.id) {
          this.finishTurn(before.id, 'switched');
          await this.disposeAgent(before.id).catch(() => {});
        }
        const index = this.conversations.list(accountId, userId).find((item) => item.id === conversation.id)?.index;
        const record = this.agents.get(conversation.id);
        const model = this.modelLabel(this.currentModel(record, conversation));
        return {
          text: [
            `已进入会话 #${index}：${conversation.title}`,
            `会话 id：${conversation.id}`,
            `模型：${model}`,
            record ? `状态：${record.agent.status}` : '状态：下次消息时恢复该会话',
          ].join('\n'),
        };
      }
      case '/model':
        return this.switchModel(accountId, userId, command.args);
      case '/workspace':
      case '/ws': {
        const raw = command.args.trim();
        if (!raw || raw.toLowerCase() === 'list') {
          return { text: this.formatWorkspaceList(accountId, userId) };
        }
        if (raw.toLowerCase() === 'here') {
          const conversation = this.currentConversation(accountId, userId);
          return {
            text: `当前工作区：${this.currentWorkspace(conversation)}\n会话：${conversation.title}`,
          };
        }
        if (/^(new|create)$/i.test(raw)) {
          return { text: '用法：/workspace new <路径> [标题]' };
        }
        const base = this.currentWorkspace(this.currentConversation(accountId, userId));
        const createMatch = raw.match(/^(new|create)\s+(.+)$/i);
        if (createMatch) {
          let rest = createMatch[2].trim();
          let rawPath = rest;
          let title = '';
          const quote = rest[0];
          if ((quote === '"' || quote === "'") && rest.indexOf(quote, 1) > 0) {
            const end = rest.indexOf(quote, 1);
            rawPath = rest.slice(1, end);
            title = rest.slice(end + 1).trim();
          } else {
            const space = rest.indexOf(' ');
            if (space !== -1) {
              rawPath = rest.slice(0, space);
              title = rest.slice(space + 1).trim();
            }
          }
          try {
            const target = await this.createWorkspaceRegistration(rawPath, title || undefined, base);
            return this.switchWorkspace(accountId, userId, target);
          } catch (error) {
            return { text: `创建工作区失败：${errorMessage(error)}` };
          }
        }
        try {
          const target = await this.resolveWorkspaceTarget(raw, { base });
          return this.switchWorkspace(accountId, userId, target);
        } catch (error) {
          return {
            text: [
              `切换工作区失败：${errorMessage(error)}`,
              '如果目录还不存在，用 /workspace new <路径> [标题] 创建。',
            ].join('\n'),
          };
        }
      }
      case '/title': {
        const conversation = this.currentConversation(accountId, userId);
        if (!command.args) {
          return { text: `当前标题：${conversation.title}\n用法：/title <新标题>` };
        }
        const renamed = this.conversations.rename(accountId, userId, command.args);
        this.renameSessionTitle(this.agents.get(renamed.id), renamed);
        return { text: `已重命名为：${renamed.title}` };
      }
      case '/status': {
        const conversation = this.currentConversation(accountId, userId);
        const record = this.agents.get(conversation.id);
        const index = this.conversations.list(accountId, userId).find((item) => item.id === conversation.id)?.index;
        const model = this.modelLabel(this.currentModel(record, conversation));
        return {
          text: [
            'ClawBot 状态',
            `账号: ${accountId}`,
            `用户: ${userId}`,
            `当前会话: #${index} ${conversation.title}`,
            `会话 id: ${conversation.id}`,
            `模型: ${model}`,
            `运行: ${record ? record.agent.status : '未创建'}`,
            `工作区: ${this.currentWorkspace(conversation)}`,
          ].join('\n'),
        };
      }
      case '/stop': {
        const conversation = this.currentConversation(accountId, userId);
        const record = this.agents.get(conversation.id);
        if (!record) return { text: '当前没有运行中的任务。' };
        record.agent.cancel({ kind: 'user' });
        return { text: '已请求停止当前任务。' };
      }
      case '/whoami': {
        const conversation = this.currentConversation(accountId, userId);
        return {
          text: [
            `账号: ${accountId}`,
            `用户: ${userId}`,
            `当前会话: ${conversation.title} (${conversation.id})`,
          ].join('\n'),
        };
      }
      case '/send': {
        if (!command.args) return { text: '用法：/send <工作区内文件路径>' };
        try {
          const conversation = this.currentConversation(accountId, userId);
          const workspace = this.currentWorkspace(conversation);
          const root = await fs.promises.realpath(workspace);
          const candidate = await fs.promises.realpath(path.resolve(workspace, command.args));
          const relative = path.relative(root, candidate);
          if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { text: '只能发送工作区内的文件。' };
          }
          await this.transport.send({ accountId, userId, mediaPath: candidate });
          return null;
        } catch (error) {
          return { text: `发送失败: ${errorMessage(error)}` };
        }
      }
      case '/help':
        return {
          text: [
            '微信 ClawBot 命令：',
            '/new [标题] — 开启新会话',
            '/list — 列出所有会话',
            '/use <序号|id|标题> — 进入指定会话',
            '/title <标题> — 重命名当前会话',
            '/model — 查看/切换模型',
            '/model <序号|provider/model> — 切换模型',
            '/workspace — 列出/切换工作区',
            '/workspace <序号|标题|路径> — 切换到该工作区（新会话）',
            '/workspace new <路径> [标题] — 创建并登记工作区',
            '/status — 查看当前状态',
            '/stop — 停止当前任务',
            '/whoami — 查看账号/会话',
            '/send <路径> — 发送工作区内文件',
            '/help — 显示帮助',
          ].join('\n'),
        };
      default:
        return { text: `未知命令：${command.name}\n发送 /help 查看可用命令。` };
    }
  }

  status() {
    return {
      workspace: this.workspace,
      sessions: [...this.agents.values()].map((record) => ({
        sessionId: record.sessionId,
        status: record.agent.status,
      })),
    };
  }
}
