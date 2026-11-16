import fs from 'node:fs';
import path from 'node:path';

import { normalizeAccountId, writeJsonAtomic, readJson } from './util.js';
import { loadPluginApi } from './plugin-api.js';

const BOT_TYPE = '3';
const QR_TIMEOUT_MS = 15_000;
const QR_POLL_TIMEOUT_MS = 35_000;

/**
 * QR status polling receives a base URL from the browser after an iLink IDC
 * redirect. Keep that value on Tencent's HTTPS origins so a local caller
 * cannot turn this route into an SSRF probe.
 */
export function normalizeQrBaseUrl(raw, fallback) {
  const value = String(raw ?? fallback ?? '').trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid QR polling base URL');
  }
  if (url.protocol !== 'https:') throw new Error('QR polling base URL must use https');
  if (url.username || url.password) throw new Error('QR polling base URL must not contain credentials');
  const host = url.hostname.toLowerCase();
  if (
    host !== 'weixin.qq.com' &&
    !host.endsWith('.weixin.qq.com') &&
    host !== 'qq.com' &&
    !host.endsWith('.qq.com')
  ) {
    throw new Error(`QR polling host is not allowed: ${host}`);
  }
  return url.origin;
}

function localTokenList(api) {
  const ids = api.listIndexedWeixinAccountIds();
  const tokens = [];
  for (let i = ids.length - 1; i >= 0 && tokens.length < 10; i -= 1) {
    const token = api.loadWeixinAccount(ids[i])?.token?.trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

export async function startQrLogin() {
  const api = await loadPluginApi();
  const raw = await api.apiPostFetch({
    baseUrl: api.DEFAULT_BASE_URL,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`,
    body: JSON.stringify({ local_token_list: localTokenList(api) }),
    timeoutMs: QR_TIMEOUT_MS,
    label: 'fetchQRCode',
  });
  const parsed = JSON.parse(raw);
  if (!parsed?.qrcode) {
    throw new Error(parsed?.message ?? 'ClawBot did not return a QR code');
  }
  return {
    qrcode: String(parsed.qrcode),
    qrUrl: String(parsed.qrcode_img_content ?? ''),
    baseUrl: api.DEFAULT_BASE_URL,
  };
}

export async function pollQrLogin({ qrcode, baseUrl, verifyCode }) {
  const api = await loadPluginApi();
  const safeBaseUrl = normalizeQrBaseUrl(baseUrl, api.DEFAULT_BASE_URL);
  let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  if (verifyCode) endpoint += `&verify_code=${encodeURIComponent(verifyCode)}`;

  let raw;
  try {
    raw = await api.apiGetFetch({
      baseUrl: safeBaseUrl,
      endpoint,
      timeoutMs: QR_POLL_TIMEOUT_MS,
      label: 'pollQRStatus',
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'wait' };
    }
    // Gateway timeouts and transient network errors are normal during the
    // long-poll; the web page simply polls again.
    return { status: 'wait', message: error instanceof Error ? error.message : String(error) };
  }

  const parsed = JSON.parse(raw);
  const status = String(parsed?.status ?? 'wait');
  if (status === 'confirmed') {
    if (!parsed.bot_token || !parsed.ilink_bot_id) {
      throw new Error('ClawBot confirmed the scan but did not return bot credentials');
    }
    const accountId = normalizeAccountId(parsed.ilink_bot_id);
    api.saveWeixinAccount(accountId, {
      token: parsed.bot_token,
      baseUrl: parsed.baseurl,
      userId: parsed.ilink_user_id,
    });
    api.registerWeixinAccountId(accountId);
    writeAllowFrom(api, accountId, parsed.ilink_user_id);
    return {
      status: 'confirmed',
      accountId,
      userId: parsed.ilink_user_id,
      baseUrl: parsed.baseurl || baseUrl,
    };
  }

  if (status === 'scaned_but_redirect' && parsed.redirect_host) {
    return {
      status,
      redirectHost: String(parsed.redirect_host),
    };
  }

  if (status === 'binded_redirect') {
    const ids = api.listIndexedWeixinAccountIds();
    return {
      status,
      accountId: ids[0],
      message: 'This ClawBot is already bound to the local account.',
    };
  }

  return {
    status,
    message: typeof parsed?.message === 'string' ? parsed.message : undefined,
  };
}

export function writeAllowFrom(api, accountId, userId) {
  const owner = String(userId ?? '').trim();
  if (!owner) {
    throw new Error(
      'ClawBot login did not return ilink_user_id; refusing to start with an open allowlist',
    );
  }
  const filePath = api.resolveFrameworkAllowFromPath(accountId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeJsonAtomic(filePath, { version: 1, allowFrom: [owner] }, 0o600);
  return filePath;
}

/**
 * The plugin calls this identity "bot_agent"; it is observability metadata only.
 * Write it before the first API call so the cached config reader sees DSH.
 */
export function writeBotAgentIdentity(stateDir, name = 'DSH-ClawBot/0.1') {
  const filePath = path.join(stateDir, 'openclaw.json');
  const config = readJson(filePath, {}) ?? {};
  config.channels ??= {};
  const section = config.channels['openclaw-weixin'] ?? {};
  section.botAgent = name;
  config.channels['openclaw-weixin'] = section;
  writeJsonAtomic(filePath, config, 0o600);
  process.env.OPENCLAW_CONFIG = filePath;
  return filePath;
}
