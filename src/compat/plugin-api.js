import fs from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The only place that imports Tencent's OpenClaw Weixin plugin internals.
 * Keeping every deep import here makes plugin upgrades a one-file review.
 */
let loaded;

function readPackageJson() {
  try {
    const require = createRequire(import.meta.url);
    const filePath = require.resolve('@tencent-weixin/openclaw-weixin/package.json');
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

export async function loadPluginApi() {
  if (!loaded) {
    loaded = (async () => {
      const channel = await import('@tencent-weixin/openclaw-weixin/dist/src/channel.js');
      const api = await import('@tencent-weixin/openclaw-weixin/dist/src/api/api.js');
      const accounts = await import('@tencent-weixin/openclaw-weixin/dist/src/auth/accounts.js');
      const pairing = await import('@tencent-weixin/openclaw-weixin/dist/src/auth/pairing.js');
      const inbound = await import('@tencent-weixin/openclaw-weixin/dist/src/messaging/inbound.js');
      const send = await import('@tencent-weixin/openclaw-weixin/dist/src/messaging/send.js');
      const sendMedia = await import('@tencent-weixin/openclaw-weixin/dist/src/messaging/send-media.js');

      const packageJson = readPackageJson();

      return {
        weixinPlugin: channel.weixinPlugin,
        apiGetFetch: api.apiGetFetch,
        apiPostFetch: api.apiPostFetch,
        parseWeixinApiJson: api.parseWeixinApiJson,
        DEFAULT_BASE_URL: accounts.DEFAULT_BASE_URL,
        CDN_BASE_URL: accounts.CDN_BASE_URL,
        listIndexedWeixinAccountIds: accounts.listIndexedWeixinAccountIds,
        loadWeixinAccount: accounts.loadWeixinAccount,
        saveWeixinAccount: accounts.saveWeixinAccount,
        clearWeixinAccount: accounts.clearWeixinAccount,
        registerWeixinAccountId: accounts.registerWeixinAccountId,
        unregisterWeixinAccountId: accounts.unregisterWeixinAccountId,
        resolveWeixinAccount: accounts.resolveWeixinAccount,
        resolveFrameworkAllowFromPath: pairing.resolveFrameworkAllowFromPath,
        getContextToken: inbound.getContextToken,
        sendMessageWeixin: send.sendMessageWeixin,
        sendWeixinMediaFile: sendMedia.sendWeixinMediaFile,
        version: packageJson.version ?? 'unknown',
        ilinkAppId: packageJson.ilink_appid ?? 'bot',
      };
    })();
  }
  return loaded;
}
