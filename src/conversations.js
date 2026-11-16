import crypto from 'node:crypto';

import { readJson, writeJsonAtomic } from './util.js';

const DEFAULT_TITLE = /^会话 \d+$/;
const MAX_TITLE = 40;

function now() {
  return Date.now();
}

function cleanTitle(value, fallback) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
  return text || fallback;
}

function newSessionId() {
  return `clawbot-${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Per-WeChat-peer conversation bookkeeping. The DSH Session remains the source
 * of truth for history; this file only remembers which Session each WeChat
 * chat is currently using and the user's title/model choices.
 */
export class ConversationStore {
  constructor({ filePath, legacyPath, log }) {
    this.filePath = filePath;
    this.legacyPath = legacyPath;
    this.log = log ?? (() => {});
    this.data = this.load();
  }

  load() {
    const current = readJson(this.filePath);
    if (current && current.version === 1 && current.peers && typeof current.peers === 'object') {
      return current;
    }
    return this.migrateLegacy();
  }

  migrateLegacy() {
    const legacy = readJson(this.legacyPath, {});
    const peers = {};
    for (const [key, sessionId] of Object.entries(legacy ?? {})) {
      if (typeof sessionId !== 'string' || !sessionId) continue;
      const [accountId, ...rest] = key.split('\u0000');
      const userId = rest.join('\u0000') || key;
      peers[key] = {
        current: sessionId,
        conversations: [
          {
            id: sessionId,
            title: '会话 1',
            createdAt: now(),
            lastActiveAt: now(),
          },
        ],
      };
    }
    const data = { version: 1, peers };
    if (Object.keys(peers).length > 0) this.saveData(data);
    return data;
  }

  saveData(data = this.data) {
    try {
      writeJsonAtomic(this.filePath, data);
    } catch (error) {
      this.log(`conversation store write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  save() {
    this.saveData();
  }

  peerKey(accountId, userId) {
    return `${accountId}\u0000${userId}`;
  }

  peer(accountId, userId, create = true) {
    const key = this.peerKey(accountId, userId);
    let peer = this.data.peers[key];
    if (!peer && create) {
      peer = { current: '', conversations: [] };
      this.data.peers[key] = peer;
    }
    if (peer) {
      peer.conversations ??= [];
      if (!peer.current && peer.conversations.length > 0) {
        peer.current = peer.conversations[peer.conversations.length - 1].id;
      }
    }
    return peer;
  }

  current(accountId, userId) {
    const peer = this.peer(accountId, userId, true);
    let conversation = peer.conversations.find((item) => item.id === peer.current);
    if (!conversation) {
      conversation = this.create(accountId, userId);
    }
    return conversation;
  }

  create(accountId, userId, title) {
    const peer = this.peer(accountId, userId, true);
    const conversation = {
      id: newSessionId(),
      title: cleanTitle(title, `会话 ${peer.conversations.length + 1}`),
      createdAt: now(),
      lastActiveAt: now(),
    };
    peer.conversations.push(conversation);
    peer.current = conversation.id;
    this.save();
    return conversation;
  }

  list(accountId, userId) {
    const peer = this.peer(accountId, userId, true);
    return peer.conversations.map((conversation, index) => ({
      ...conversation,
      index: index + 1,
      current: conversation.id === peer.current,
    }));
  }

  switch(accountId, userId, selector) {
    const peer = this.peer(accountId, userId, true);
    const list = peer.conversations;
    const raw = String(selector ?? '').trim();
    if (!raw) return undefined;
    let conversation;
    if (/^\d+$/.test(raw)) {
      conversation = list[Number(raw) - 1];
    } else {
      const lower = raw.toLowerCase();
      conversation =
        list.find((item) => item.id === raw) ??
        list.find((item) => item.id.startsWith(raw)) ??
        list.find((item) => String(item.title ?? '').toLowerCase() === lower);
    }
    if (!conversation) return undefined;
    peer.current = conversation.id;
    conversation.lastActiveAt = now();
    this.save();
    return conversation;
  }

  rename(accountId, userId, title) {
    const conversation = this.current(accountId, userId);
    conversation.title = cleanTitle(title, conversation.title);
    this.save();
    return conversation;
  }

  maybeTitle(accountId, userId, text) {
    const conversation = this.current(accountId, userId);
    const value = String(text ?? '').trim();
    if (!value || value.startsWith('/') || !DEFAULT_TITLE.test(conversation.title)) {
      return conversation;
    }
    conversation.title = cleanTitle(value, conversation.title);
    this.save();
    return conversation;
  }

  setWorkspace(accountId, userId, workspace) {
    const conversation = this.current(accountId, userId);
    conversation.workspace = workspace;
    conversation.lastActiveAt = now();
    this.save();
    return conversation;
  }

  setModel(accountId, userId, model) {
    const conversation = this.current(accountId, userId);
    conversation.model = model;
    conversation.lastActiveAt = now();
    this.save();
    return conversation;
  }

  touch(accountId, userId) {
    const conversation = this.current(accountId, userId);
    conversation.lastActiveAt = now();
    this.save();
    return conversation;
  }

  findBySessionId(sessionId) {
    for (const [key, peer] of Object.entries(this.data.peers)) {
      const conversation = peer.conversations?.find((item) => item.id === sessionId);
      if (!conversation) continue;
      const separator = key.indexOf('\u0000');
      const accountId = separator === -1 ? 'default' : key.slice(0, separator);
      const userId = separator === -1 ? key : key.slice(separator + 1);
      return { accountId, userId, conversation, peer };
    }
    return undefined;
  }
}
