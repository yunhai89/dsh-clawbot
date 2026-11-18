import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConversationStore } from './conversations.js';
import { detectImageMime, ensureDir, isVoiceFilePath, safeFilename } from './util.js';
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

const FAILURE_HINTS = {
  ACCOUNT_QUOTA: '账户额度不足',
  ACCOUNT_SIGN_IN_REQUIRED: '需要重新登录模型账号',
  ACCOUNT_TOKEN_INVALID: '模型账号令牌无效',
  AUTH: '模型鉴权失败',
  CONTEXT_WINDOW_EXCEEDED: '上下文超出模型窗口',
  EMPTY_RESPONSE: '模型返回空响应',
  INVALID_CREDENTIAL: '模型凭证无效',
  INVALID_REQUEST: '模型请求无效',
  MISSING_CREDENTIAL: '缺少模型凭证',
  MODEL_UNSUPPORTED: '当前模型不支持该请求',
  QUOTA: '账户额度或余额不足',
  RATE_LIMIT: '模型请求被限流',
  SERVER: '模型服务端错误',
  TIMEOUT: '模型请求超时',
  TRANSPORT: '模型网络传输失败',
};

const GOAL_PHASE_LABELS = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  complete: '已完成',
};

const GOAL_ERROR_HINTS = {
  GOAL_AGENT_NOT_LIVE: '目标会话尚未恢复，请重试',
  GOAL_ALREADY_EXISTS: '当前已有未完成目标',
  GOAL_INVALID_BLOCK_REASON: '阻塞原因不能为空',
  GOAL_INVALID_EDIT: '没有提供要修改的内容',
  GOAL_INVALID_MAX_ROUNDS: '轮数必须是正整数',
  GOAL_INVALID_OBJECTIVE: '目标内容不能为空',
  GOAL_INVALID_TRANSITION: '当前目标状态不支持该操作',
  GOAL_NOT_FOUND: '当前没有目标',
  GOAL_STALE_REVISION: '目标状态已变化，请重新发送 /goal',
};

function reasonKind(reason) {
  if (!reason) return undefined;
  if (typeof reason === 'string') return reason;
  return reason.kind;
}

function formatTurnReason(reason) {
  const kind = reasonKind(reason);
  if (kind === 'error') {
    const failure = typeof reason === 'object' ? reason.error : undefined;
    const message =
      typeof failure === 'string'
        ? failure
        : failure?.message ?? 'unknown error';
    const code = typeof failure === 'object' && failure?.code ? String(failure.code) : '';
    const hint = code ? FAILURE_HINTS[code] : undefined;
    const details = [];
    if (code) details.push(code);
    if (typeof failure === 'object' && failure?.status) details.push(`HTTP ${failure.status}`);
    if (typeof failure === 'object' && failure?.requestId) details.push(`请求 ${failure.requestId}`);
    return redactForWeChat(
      truncateText(
        `模型调用失败${hint ? `（${hint}）` : ''}：${message}${
          details.length > 0 ? ` [${details.join(' | ')}]` : ''
        }`,
        1500,
      ),
    );
  }

  switch (kind) {
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '本轮已取消';
    case 'aborted': {
      const cause = typeof reason === 'object' ? reason.reason : undefined;
      const label =
        cause?.kind === 'user'
          ? '用户停止'
          : cause?.kind === 'disposed'
            ? '会话已释放'
            : cause?.kind === 'parent'
              ? '父会话中止'
              : cause?.kind === 'hook'
                ? redactForWeChat(cause.reason)
                : undefined;
      return label ? `本轮已中止（${label}）` : '本轮已中止';
    }
    case 'blocked':
      return '本轮被前置检查拦截';
    case 'max-tokens':
      return '本轮达到输出 token 上限';
    case 'timeout':
      return '本轮执行超时';
    case 'interrupted':
      return '本轮因进程中断而中止';
    case 'forked':
      return '本轮在会话分叉时结束';
    case 'switched':
      return '会话已切换';
    case 'replaced':
      return '本轮已被新的消息替换';
    case 'stopped':
    case 'stopping':
      return 'ClawBot 通道已停止';
    default:
      return kind ? String(kind) : '未知原因';
  }
}

function formatTurnReport(messages, reason) {
  const reply = lastAssistantText(messages);
  const tools = toolNamesOf(messages);
  const kind = reasonKind(reason);

  if (kind === 'error') {
    const parts = [`本轮执行失败：${formatTurnReason(reason)}`];
    if (reply) parts.push(`失败前的回复：\n${reply}`);
    if (tools.length > 0) parts.push(`失败前调用过：${tools.join(', ')}`);
    return parts.join('\n\n');
  }

  if (kind && kind !== 'completed') {
    const detail = formatTurnReason(reason);
    if (reply) return `${reply}\n\n（${detail}）`;
    if (tools.length > 0) return `已执行：${tools.join(', ')}\n（${detail}）`;
    return `（${detail}）`;
  }

  if (reply) return reply;
  if (tools.length > 0) return `已执行：${tools.join(', ')}`;
  return '（本轮没有文字回复）';
}

function formatGoalStatus(goal) {
  if (!goal) {
    return [
      '当前没有目标。',
      '',
      '发送 /goal <目标> 创建目标，DSH 会围绕该目标自动继续执行。',
    ].join('\n');
  }

  const lines = [
    `目标：${goal.objective}`,
    `状态：${GOAL_PHASE_LABELS[goal.phase] ?? goal.phase}`,
    `轮次：${goal.roundsStarted}/${goal.maxGoalRounds}`,
    `自动继续：${goal.activation === 'armed' ? '已开启' : '已暂停'}`,
  ];
  if (goal.phase === 'blocked' && goal.blockedReason) {
    lines.push(
      `阻塞原因：${goal.blockedReason.message}${
        goal.blockedReason.code ? ` (${goal.blockedReason.code})` : ''
      }`,
    );
  }
  lines.push('', `操作：${formatGoalHint(goal)}`);
  return lines.join('\n');
}

function formatGoalHint(goal) {
  if (!goal) return '/goal <目标> — 创建目标';
  if (goal.phase === 'complete') {
    return '/goal <目标> — 创建新目标 · /goal clear — 清除记录';
  }
  const hints = [
    '/goal edit <目标> — 修改目标',
    goal.phase === 'active' && goal.activation === 'armed'
      ? '/goal pause — 暂停自动继续'
      : '/goal resume — 恢复执行',
    '/goal complete — 标记完成',
    '/goal clear — 清除目标',
  ];
  return hints.join(' · ');
}

function formatGoalError(error) {
  const code = error?.code ? String(error.code) : '';
  const hint = code ? GOAL_ERROR_HINTS[code] : undefined;
  return `目标操作失败${hint ? `（${hint}）` : ''}：${redactForWeChat(errorMessage(error))}${
    code ? ` (${code})` : ''
  }`;
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

function splitPathArgument(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { path: '', rest: '' };
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
    const end = value.indexOf(quote, 1);
    return { path: value.slice(1, end).trim(), rest: value.slice(end + 1).trim() };
  }
  const space = value.indexOf(' ');
  if (space === -1) return { path: value, rest: '' };
  return { path: value.slice(0, space), rest: value.slice(space + 1).trim() };
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
    this.goalTurns = new Map();
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
    for (const [sessionId, entry] of [...this.goalTurns]) {
      clearTimeout(entry.timer);
      this.goalTurns.delete(sessionId);
    }
    this.conversations.flush();
    await this.transport.stop().catch(() => {});
  }

  isPeerSession(session) {
    let current = session;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      if (this.agents.has(current.id) || this.conversations.findBySessionId(current.id)) {
        return true;
      }
      const parent = current.header?.parentSession;
      if (!parent) return false;
      const parentSession = this.ctx.sessions?.get?.(parent);
      if (parentSession) {
        current = parentSession;
      } else {
        return Boolean(this.agents.has(parent) || this.conversations.findBySessionId(parent));
      }
    }
    return false;
  }

  resolvePeerRecord(request) {
    let session = request?.agent?.session;
    let sessionId = String(request?.agent?.id ?? session?.id ?? '');
    const originalSessionId = sessionId;
    let delegated = false;
    for (let depth = 0; depth < 6 && sessionId; depth += 1) {
      const record = this.agents.get(sessionId);
      if (record) {
        return {
          record: {
            accountId: record.accountId,
            userId: record.userId,
            sessionId,
          },
          conversation: record.conversation,
          originalSessionId,
          delegated,
        };
      }
      const found = this.conversations.findBySessionId(sessionId);
      if (found) {
        return {
          record: {
            accountId: found.accountId,
            userId: found.userId,
            sessionId,
          },
          conversation: found.conversation,
          originalSessionId,
          delegated,
        };
      }
      const parent = session?.header?.parentSession ?? this.ctx.sessions?.get?.(sessionId)?.header?.parentSession;
      if (!parent) return undefined;
      delegated = true;
      sessionId = parent;
      session = this.ctx.sessions?.get?.(parent);
    }
    return undefined;
  }

  onSessionEvent(session, event) {
    const ours =
      (event.type === 'tool/call' || event.type === 'tool/result') && this.isPeerSession(session);
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
    if (event.type === 'assistant/message') {
      if (turn) {
        turn.assistant.push(event.data.message);
      } else {
        this.goalTurns.get(session.id)?.assistant.push(event.data.message);
      }
      return;
    }
    if (event.type === 'turn/end') {
      if (turn) {
        this.finishTurn(session.id, event.data.reason);
      } else {
        this.finishGoalTurn(session.id, event.data.reason);
      }
      return;
    }
    if (event.type === 'deliverables/presented') {
      const holder = turn ?? this.goalTurns.get(session.id);
      if (holder && Array.isArray(event.data?.files)) {
        holder.deliverables.push(...event.data.files);
      }
      return;
    }
    if (event.type === 'user/message' && !turn && this.config.goalProgress !== false) {
      const record = this.agents.get(session.id);
      if (record && event.data?.source?.kind === 'goal') {
        this.beginGoalTurn(record, event.data.source);
      }
    }
  }

  beginGoalTurn(record, source) {
    const sessionId = record.sessionId;
    if (this.turns.has(sessionId)) return;
    const existing = this.goalTurns.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const entry = {
      accountId: record.accountId,
      userId: record.userId,
      round: Number(source?.round) || 0,
      assistant: [],
      deliverables: [],
      timer: setTimeout(() => this.finishGoalTurn(sessionId, 'timeout'), TURN_TIMEOUT_MS),
    };
    entry.timer.unref?.();
    this.goalTurns.set(sessionId, entry);
  }

  finishGoalTurn(sessionId, reason) {
    const entry = this.goalTurns.get(sessionId);
    if (!entry) return;
    this.goalTurns.delete(sessionId);
    clearTimeout(entry.timer);
    void this.deliverGoalTurn(sessionId, entry, reason).catch((error) => {
      this.log(`goal turn delivery failed: ${errorMessage(error)}`);
    });
  }

  async deliverGoalTurn(sessionId, entry, reason) {
    const record = this.agents.get(sessionId);
    const prefix = entry.round > 0 ? `【目标 · 第 ${entry.round} 轮】` : '【目标】';
    const parts = [`${prefix}\n${formatTurnReport(entry.assistant, reason)}`];

    try {
      const goals = this.ctx.get('goals');
      const goal = record ? goals?.get?.(record.agent) : undefined;
      if (goal) {
        if (goal.phase === 'complete') {
          parts.push(`目标已完成：${goal.objective}`);
        } else if (goal.phase === 'blocked') {
          parts.push(
            `目标已阻塞：${goal.blockedReason?.message ?? goal.objective}\n发送 /goal resume 可继续。`,
          );
        } else if (goal.phase === 'paused') {
          parts.push('目标已暂停，发送 /goal resume 恢复。');
        } else if (
          goal.activation === 'disarmed'
          || reasonKind(reason) === 'error'
          || reasonKind(reason) === 'max-tokens'
          || reasonKind(reason) === 'timeout'
        ) {
          parts.push('目标自动继续已暂停，发送 /goal resume 恢复。');
        }
      }
    } catch (error) {
      this.log(`goal status lookup failed: ${errorMessage(error)}`);
    }

    await this.transport.send({
      accountId: entry.accountId,
      userId: entry.userId,
      text: parts.join('\n\n'),
    });

    if (record) {
      const delivery = await this.sendDeliverables(record, entry.deliverables);
      if (delivery.failed.length > 0) {
        await this.transport.send({
          accountId: entry.accountId,
          userId: entry.userId,
          text: `以下目标文件未发送：\n${delivery.failed.join('\n')}`,
        });
      }
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
      entry.delegated
        ? `来源：子 Agent 会话 ${String(entry.originSessionId).slice(0, 20)}`
        : '',
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
      void this.transport
        .send({
          accountId: record.accountId,
          userId: record.userId,
          text: '⏱ 权限申请已超时，已按拒绝处理。',
        })
        .catch(() => {});
      this.finishApproval(entry, 'cancelled');
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
    const resolved = this.resolvePeerRecord(request);
    if (!resolved?.record?.accountId || !resolved?.record?.userId) return next();
    const { record, conversation, originalSessionId, delegated } = resolved;
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
      sessionId: record.sessionId,
      originSessionId: originalSessionId,
      delegated,
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
      deliverables: [],
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
    turn.resolve({ assistant: turn.assistant, deliverables: turn.deliverables, reason });
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
        try {
          agentCtx.inject(['systemPrompt'], (scope) => {
            scope.systemPrompt.section({
              name: 'clawbot:media',
              order: scope.systemPrompt.getSectionOrder('FILE_REFERENCE'),
              text:
                'This DSH session is bridged to WeChat. When the user asks for an image, '
                + 'file, video, or voice message, create or locate the file and call present '
                + 'with absolute path(s); files presented at the end of the turn are sent to '
                + 'the WeChat chat automatically. Audio files are attempted as native voice '
                + 'messages when possible; unsupported codecs are sent as files. '
                + 'Files must be inside the session workspace.',
            });
          });
        } catch (error) {
          this.log(`system prompt media guidance failed: ${errorMessage(error)}`);
        }
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

  async resolveOutboundFile(accountId, userId, rawPath) {
    const value = String(rawPath ?? '').trim();
    if (!value) throw new Error('文件路径为空');
    const conversation = this.currentConversation(accountId, userId);
    const workspace = this.currentWorkspace(conversation);
    const root = await fs.promises.realpath(workspace);
    const candidate = await fs.promises.realpath(path.resolve(workspace, value));
    const relative = path.relative(root, candidate);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('只能发送工作区内的文件');
    }
    const stat = await fs.promises.stat(candidate);
    if (!stat.isFile()) throw new Error('不是普通文件');
    if (stat.size > FILE_MAX_BYTES) {
      throw new Error(`文件过大（${stat.size} bytes，上限 ${FILE_MAX_BYTES}）`);
    }
    return candidate;
  }

  async sendDeliverables(record, files) {
    const sent = [];
    const failed = [];
    const seen = new Set();
    for (const file of Array.isArray(files) ? files : []) {
      const rawPath = typeof file === 'string' ? file : file?.path;
      if (!rawPath) continue;
      let target;
      try {
        target = await this.resolveOutboundFile(record.accountId, record.userId, rawPath);
      } catch (error) {
        failed.push(`${rawPath}（${errorMessage(error)}）`);
        continue;
      }
      if (seen.has(target)) continue;
      seen.add(target);
      const caption =
        typeof file === 'object' && file?.description
          ? redactForWeChat(file.description)
          : undefined;
      try {
        if (isVoiceFilePath(target)) {
          await this.transport.send({
            accountId: record.accountId,
            userId: record.userId,
            voicePath: target,
            ...(caption ? { text: caption } : {}),
          });
        } else {
          await this.transport.send({
            accountId: record.accountId,
            userId: record.userId,
            mediaPath: target,
            ...(caption ? { text: caption } : {}),
          });
        }
        sent.push(target);
      } catch (error) {
        failed.push(`${target}（${errorMessage(error)}）`);
      }
    }
    return { sent, failed };
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
      const delivery = await this.sendDeliverables(record, result.deliverables);
      let text = formatTurnReport(result.assistant, result.reason);
      if (delivery.sent.length > 0 && text === '（本轮没有文字回复）') {
        text = `已发送 ${delivery.sent.length} 个文件。`;
      }
      if (delivery.failed.length > 0) {
        text += `${text ? '\n\n' : ''}以下文件未发送：\n${delivery.failed.join('\n')}`;
      }
      return { text };
    } catch (error) {
      this.finishTurn(record.sessionId, 'error');
      throw error;
    }
  }

  async handleCommand(message, command) {
    const accountId = message.accountId;
    const userId = message.userId;
    switch (command.name) {
      case '/goal':
      case '/target':
      case '/目标':
        return this.handleGoalCommand(message, command);
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
        if (!command.args) return { text: '用法：/send <工作区内文件路径> [说明]' };
        try {
          const { path: rawPath, rest } = splitPathArgument(command.args);
          const target = await this.resolveOutboundFile(accountId, userId, rawPath);
          await this.transport.send({
            accountId,
            userId,
            mediaPath: target,
            ...(rest ? { text: rest } : {}),
          });
          return null;
        } catch (error) {
          return { text: `发送失败: ${errorMessage(error)}` };
        }
      }
      case '/voice': {
        if (!command.args) return { text: '用法：/voice <工作区内音频路径> [说明]' };
        try {
          const { path: rawPath, rest } = splitPathArgument(command.args);
          const target = await this.resolveOutboundFile(accountId, userId, rawPath);
          if (!isVoiceFilePath(target)) {
            return {
              text: '无法作为语音发送：请使用音频文件（.silk/.wav 可直接转换，其他格式需要 ffmpeg）。',
            };
          }
          await this.transport.send({
            accountId,
            userId,
            voicePath: target,
            ...(rest ? { text: rest } : {}),
          });
          return null;
        } catch (error) {
          return { text: `语音发送失败: ${errorMessage(error)}` };
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
            '/goal — 查看当前目标',
            '/goal <目标> — 创建目标并自动继续执行',
            '/goal edit <目标> — 修改目标',
            '/goal pause|resume|complete|clear — 控制目标',
            '/goal rounds <轮数> — 修改自动继续轮数上限',
            '/status — 查看当前状态',
            '/stop — 停止当前任务',
            '/whoami — 查看账号/会话',
            '/send <路径> [说明] — 发送工作区内图片/文件/视频',
            '/voice <路径> [说明] — 发送工作区内音频为微信语音',
            '/help — 显示帮助',
          ].join('\n'),
        };
      default:
        return { text: `未知命令：${command.name}\n发送 /help 查看可用命令。` };
    }
  }

  async handleGoalCommand(message, command) {
    const accountId = message.accountId;
    const userId = message.userId;
    const goals = this.ctx.get('goals');
    if (!goals || typeof goals.get !== 'function' || typeof goals.create !== 'function') {
      return {
        text: '当前 DSH 未启用目标服务（goals），无法使用 /goal。请确认 standard preset 已加载 dsh-goal。',
      };
    }

    let record;
    try {
      this.conversations.touch(accountId, userId);
      record = await this.ensureAgent(message);
      record.lastUsedAt = Date.now();
    } catch (error) {
      return { text: `目标操作失败：无法准备当前会话：${errorMessage(error)}` };
    }

    let current;
    try {
      current = goals.get(record.agent);
    } catch (error) {
      return { text: formatGoalError(error) };
    }

    const raw = command.args.trim();
    const lower = raw.toLowerCase();
    const ref = current ? { id: current.id, revision: current.revision } : undefined;
    const created = (goal, title) => ({
      text: `${title}\n\n${formatGoalStatus(goal)}`,
    });

    try {
      if (!raw || lower === 'status' || lower === 'show') {
        return { text: formatGoalStatus(current) };
      }

      if (lower === 'clear') {
        if (!current) return { text: '当前没有目标。' };
        goals.clear(record.agent, ref);
        return { text: '目标已清除。' };
      }

      if (lower === 'pause') {
        if (!current) return { text: '当前没有目标，无法暂停。' };
        if (current.phase !== 'active') {
          return { text: `当前目标状态为「${GOAL_PHASE_LABELS[current.phase] ?? current.phase}」，无法暂停。` };
        }
        return created(goals.pause(record.agent, ref), '目标已暂停。');
      }

      if (lower === 'resume') {
        if (!current) return { text: '当前没有目标，无法恢复。' };
        if (current.phase === 'complete') return { text: '目标已经完成。发送 /goal <新目标> 创建新目标。' };
        if (current.phase === 'active' && current.activation === 'armed') {
          return { text: '目标正在执行中，无需恢复。' };
        }
        return created(goals.resume(record.agent, ref), '目标已恢复，DSH 会自动继续执行。');
      }

      if (lower === 'complete' || lower === 'done') {
        if (!current) return { text: '当前没有目标，无法标记完成。' };
        if (current.phase === 'complete') return { text: '目标已经完成。' };
        return created(goals.complete(record.agent, ref), '目标已标记完成。');
      }

      const blockMatch = raw.match(/^block(?:\s+([\s\S]+))?$/i);
      if (blockMatch) {
        if (!current) return { text: '当前没有目标，无法标记阻塞。' };
        if (current.phase !== 'active') {
          return { text: `当前目标状态为「${GOAL_PHASE_LABELS[current.phase] ?? current.phase}」，无法标记阻塞。` };
        }
        const reason = blockMatch[1]?.trim();
        if (!reason) return { text: '用法：/goal block <阻塞原因>' };
        return created(
          goals.block(record.agent, ref, { code: 'user-reported', message: reason }),
          '目标已标记阻塞。',
        );
      }

      const roundsMatch = raw.match(/^(?:rounds?|max)\s+(\d+)$/i);
      if (roundsMatch) {
        if (!current) return { text: '当前没有目标，无法设置轮数上限。' };
        const rounds = Number(roundsMatch[1]);
        if (!Number.isSafeInteger(rounds) || rounds < 1) {
          return { text: '轮数上限必须是正整数。' };
        }
        if (rounds < current.roundsStarted) {
          return { text: `轮数上限不能小于已执行轮数（${current.roundsStarted}）。` };
        }
        return created(
          goals.edit(record.agent, ref, { maxGoalRounds: rounds }),
          `轮数上限已改为 ${rounds}。`,
        );
      }

      const editMatch = raw.match(/^edit(?:\s+([\s\S]+))?$/i);
      if (editMatch) {
        const objective = editMatch[1]?.trim();
        if (!objective) return { text: '用法：/goal edit <新目标>' };
        if (!current) {
          return { text: '当前没有目标。直接发送 /goal <目标> 创建。' };
        }
        const updated =
          current.phase === 'complete'
            ? goals.create(record.agent, { objective })
            : goals.edit(record.agent, ref, { objective });
        return created(updated, current.phase === 'complete' ? '目标已创建。' : '目标已更新。');
      }

      const createMatch = raw.match(/^(?:new|create)\s+([\s\S]+)$/i);
      const objective = (createMatch ? createMatch[1] : raw).trim();
      if (!objective) return { text: '用法：/goal <目标>' };
      if (current && current.phase !== 'complete') {
        return {
          text: [
            `当前已有${GOAL_PHASE_LABELS[current.phase] ?? current.phase}目标：${current.objective}`,
            '请先用 /goal edit <目标> 修改，或 /goal clear 清除后再创建。',
          ].join('\n'),
        };
      }
      return created(goals.create(record.agent, { objective }), '目标已创建，DSH 会自动继续执行。');
    } catch (error) {
      return { text: formatGoalError(error) };
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
