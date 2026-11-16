/**
 * OpenClaw's account ids are used as filesystem keys for per-account state.
 * We only need the normalization contract the Weixin plugin relies on:
 *   "b0f5860fdecb@im.bot"    -> "b0f5860fdecb-im-bot"
 *   "b0f5860fdecb@im.wechat" -> "b0f5860fdecb-im-wechat"
 */
export function normalizeAccountId(raw) {
  const normalized = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/@/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'default';
}
