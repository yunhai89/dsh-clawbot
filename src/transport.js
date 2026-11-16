import crypto from 'node:crypto';

/**
 * @typedef {'image' | 'file' | 'voice' | 'video'} InboundMediaKind
 *
 * @typedef {object} InboundMedia
 * @property {InboundMediaKind} kind
 * @property {string} path        Local plaintext file on the host.
 * @property {string} [mime]
 * @property {string} [name]
 *
 * @typedef {object} InboundMessage
 * @property {string} accountId
 * @property {string} userId
 * @property {string} messageId
 * @property {string} text
 * @property {InboundMedia[]} [media]
 * @property {string} [contextToken]
 * @property {{ id?: string, text?: string }} [replyTo]
 * @property {number} [timestamp]
 *
 * @typedef {object} OutboundReply
 * @property {string} [text]
 * @property {string} [mediaPath]
 * @property {string} [mime]
 *
 * @typedef {object} OutboundMessage
 * @property {string} accountId
 * @property {string} userId
 * @property {string} [text]
 * @property {string} [mediaPath]
 *
 * @typedef {object} LoginStartResult
 * @property {string} qrcode
 * @property {string} qrUrl
 * @property {string} baseUrl
 *
 * @typedef {object} LoginPollResult
 * @property {'wait'|'scaned'|'confirmed'|'expired'|'scaned_but_redirect'|'need_verifycode'|'verify_code_blocked'|'binded_redirect'} status
 * @property {string} [message]
 * @property {string} [accountId]
 * @property {string} [userId]
 * @property {string} [redirectHost]
 *
 * @typedef {object} TransportStatus
 * @property {boolean} connected
 * @property {string} state
 * @property {Array<{ accountId: string, userId?: string, baseUrl: string, running: boolean, lastError?: string }>} accounts
 * @property {string} [lastError]
 */

/** @typedef {object} WeixinTransport
 * @property {(handler: (message: InboundMessage) => Promise<OutboundReply | null>) => Promise<void>} start
 * @property {() => Promise<void>} stop
 * @property {(message: OutboundMessage) => Promise<{ messageId: string }>} send
 * @property {() => Promise<LoginStartResult>} loginStart
 * @property {(input: { qrcode: string, baseUrl?: string, verifyCode?: string }) => Promise<LoginPollResult>} loginPoll
 * @property {() => TransportStatus} status
 * @property {() => Promise<void>} [logout]
 */

/** Stable per-WeChat-peer session identity. */
export function sessionIdFor(accountId, userId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${accountId}\u0000${userId}`)
    .digest('hex')
    .slice(0, 24);
  return `clawbot-${digest}`;
}

export function routeKeyFor(accountId, userId) {
  return `clawbot:${accountId}:${userId}`;
}

/** @param {unknown} value */
export function errorMessage(value) {
  if (value instanceof Error) return value.message;
  return String(value ?? 'unknown error');
}
