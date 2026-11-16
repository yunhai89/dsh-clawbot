import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureDir, mediaKindFromMime, safeFilename } from './util.js';
import { routeKeyFor } from '../transport.js';

const PENDING_TTL_MS = 10 * 60_000;

function extensionForMime(mime) {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'audio/wav': '.wav',
    'audio/silk': '.silk',
    'audio/mpeg': '.mp3',
    'application/pdf': '.pdf',
  };
  return map[String(mime ?? '').toLowerCase()] ?? '.bin';
}

function sanitizeSubdir(raw) {
  return String(raw ?? 'inbound')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/') || 'inbound';
}

function toInbound(ctx) {
  const media = [];
  const seen = new Set();
  const pushMedia = (filePath, mime, name) => {
    if (!filePath) return;
    const resolved = String(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const resolvedMime = mime || 'application/octet-stream';
    media.push({
      kind: mediaKindFromMime(resolvedMime),
      path: resolved,
      mime: resolvedMime,
      name: name || path.basename(resolved),
    });
  };

  if (ctx?.MediaPath) {
    pushMedia(ctx.MediaPath, ctx.MediaType, undefined);
  }
  if (Array.isArray(ctx?.MediaPaths)) {
    const types = Array.isArray(ctx.MediaTypes) ? ctx.MediaTypes : [];
    ctx.MediaPaths.forEach((filePath, index) => pushMedia(filePath, types[index], undefined));
  }
  if (Array.isArray(ctx?.media)) {
    for (const item of ctx.media) {
      pushMedia(item?.path, item?.contentType, item?.fileName);
    }
  }

  const replyTo =
    ctx?.ReplyToBody || ctx?.ReplyToId
      ? { id: ctx.ReplyToId, text: ctx.ReplyToBody }
      : undefined;

  return {
    accountId: String(ctx?.AccountId ?? ''),
    userId: String(ctx?.From ?? ctx?.To ?? ''),
    messageId: String(ctx?.MessageSidFull ?? ctx?.MessageSid ?? crypto.randomUUID()),
    text: String(ctx?.Body ?? ''),
    media,
    contextToken: typeof ctx?.context_token === 'string' ? ctx.context_token : undefined,
    replyTo,
    timestamp: Number.isFinite(ctx?.Timestamp) ? Number(ctx.Timestamp) : Date.now(),
  };
}

/**
 * The OpenClaw channelRuntime surface consumed by the Weixin plugin. It is a
 * deliberately small facade: routing/session calls are no-ops for DSH, while
 * inbound dispatch drives the A adapter and outbound delivery flows through
 * the plugin's own `deliver` callback.
 */
export function createChannelRuntime({ stateDir, onInbound, log = () => {} }) {
  /** @type {Array<{ createdAt: number, opts: any }>} */
  const pending = [];

  const prune = () => {
    const cutoff = Date.now() - PENDING_TTL_MS;
    while (pending.length > 0 && pending[0].createdAt < cutoff) pending.shift();
  };

  return {
    media: {
      async saveMediaBuffer(buffer, contentType, subdir = 'inbound', maxBytes, filename) {
        const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
        if (Number.isFinite(maxBytes) && maxBytes > 0 && data.length > maxBytes) {
          throw new Error(`media exceeds maximum size (${data.length} > ${maxBytes})`);
        }
        const dir = ensureDir(path.join(stateDir, 'media', sanitizeSubdir(subdir)));
        const name = safeFilename(
          filename || `media-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${extensionForMime(contentType)}`,
          'media.bin',
        );
        const filePath = path.join(dir, name);
        await fs.promises.writeFile(filePath, data, { mode: 0o600 });
        return { path: filePath };
      },
    },

    routing: {
      resolveAgentRoute({ accountId, peer }) {
        const key = routeKeyFor(accountId, peer?.id ?? 'unknown');
        return {
          agentId: 'clawbot',
          sessionKey: key,
          mainSessionKey: key,
        };
      },
    },

    session: {
      resolveStorePath(_store, { agentId } = {}) {
        return path.join(stateDir, 'sessions', agentId || 'clawbot');
      },
      async recordInboundSession() {
        // DSH owns session persistence; the A adapter resumes/creates by id.
      },
    },

    commands: {
      shouldComputeCommandAuthorized() {
        return false;
      },
    },

    reply: {
      finalizeInboundContext(ctx) {
        return {
          ...ctx,
          From: ctx?.From ?? ctx?.To ?? '',
          To: ctx?.To ?? ctx?.From ?? '',
          Body: String(ctx?.Body ?? ''),
        };
      },

      resolveHumanDelayConfig() {
        return undefined;
      },

      createReplyDispatcherWithTyping(opts) {
        prune();
        pending.push({ createdAt: Date.now(), opts });
        const dispatcher = {
          deliver: opts?.deliver,
          onError: opts?.onError,
        };
        return {
          dispatcher,
          replyOptions: {},
          markDispatchIdle() {},
        };
      },

      async withReplyDispatcher({ run }) {
        return run();
      },

      dispatchReplyFromConfig(params) {
        prune();
        const entry = pending.shift();
        if (!entry) throw new Error('clawbot: reply dispatcher was not created');
        const typing = entry.opts?.typingCallbacks;
        const inbound = toInbound(params?.ctx);

        // Do not block the Weixin long-poll monitor while a DSH turn runs.
        // Returning immediately keeps receiving inbound messages, which is
        // what makes remote approvals and multi-user concurrency possible.
        Promise.resolve()
          .then(() => typing?.start?.())
          .then(() => onInbound(inbound))
          .then(async (reply) => {
            if (reply && (reply.text || reply.mediaPath)) {
              const payload = {
                text: reply.text ?? '',
                ...(reply.mediaPath ? { mediaUrl: reply.mediaPath } : {}),
              };
              await entry.opts?.deliver?.(payload);
            }
          })
          .catch(async (error) => {
            log(`dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
            try {
              await entry.opts?.onError?.(error, { kind: 'dispatch' });
            } catch {
              // The plugin's error notice is best-effort.
            }
          })
          .finally(async () => {
            await typing?.stop?.();
          });

        return undefined;
      },
    },
  };
}
