import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { prepareOutboundVoice } from './voice.js';

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
      const types = await import('@tencent-weixin/openclaw-weixin/dist/src/api/types.js');
      const aes = await import('@tencent-weixin/openclaw-weixin/dist/src/cdn/aes-ecb.js');
      const cdnUpload = await import('@tencent-weixin/openclaw-weixin/dist/src/cdn/cdn-upload.js');

      // Tencent's plugin exposes image/video/file uploads but not voice. The
      // protocol still supports VOICE items, so implement the missing upload
      // path here using the plugin's own CDN primitives.
      const uploadVoiceToWeixin = async ({ filePath, toUserId, opts, cdnBaseUrl }) => {
        const plaintext = await fs.promises.readFile(filePath);
        const rawsize = plaintext.length;
        const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
        const filesize = aes.aesEcbPaddedSize(rawsize);
        const filekey = crypto.randomBytes(16).toString('hex');
        const aeskey = crypto.randomBytes(16);
        const uploadUrlResp = await api.getUploadUrl({
          ...opts,
          filekey,
          media_type: types.UploadMediaType.VOICE,
          to_user_id: toUserId,
          rawsize,
          rawfilemd5,
          filesize,
          no_need_thumb: true,
          aeskey: aeskey.toString('hex'),
        });
        const uploadFullUrl = uploadUrlResp.upload_full_url?.trim();
        const uploadParam = uploadUrlResp.upload_param;
        if (!uploadFullUrl && !uploadParam) {
          throw new Error('uploadVoiceToWeixin: getUploadUrl returned no upload URL');
        }
        const { downloadParam } = await cdnUpload.uploadBufferToCdn({
          buf: plaintext,
          uploadFullUrl: uploadFullUrl || undefined,
          uploadParam: uploadParam ?? undefined,
          filekey,
          cdnBaseUrl,
          aeskey,
          label: `uploadVoiceToWeixin[filekey=${filekey}]`,
        });
        return {
          filekey,
          downloadEncryptedQueryParam: downloadParam,
          aeskey: aeskey.toString('hex'),
          fileSize: rawsize,
          fileSizeCiphertext: filesize,
        };
      };

      const sendWeixinVoiceFile = async ({ filePath, to, opts, cdnBaseUrl }) => {
        const prepared = await prepareOutboundVoice(filePath);
        try {
          const uploaded = await uploadVoiceToWeixin({
            filePath: prepared.filePath,
            toUserId: to,
            opts,
            cdnBaseUrl,
          });
          const item = {
            type: types.MessageItemType.VOICE,
            voice_item: {
              media: {
                encrypt_query_param: uploaded.downloadEncryptedQueryParam,
                // Voice inbound uses base64(hex string), matching Tencent's
                // file/video senders.
                aes_key: Buffer.from(uploaded.aeskey).toString('base64'),
              },
              encode_type: prepared.encodeType,
              bits_per_sample: prepared.bitsPerSample,
              sample_rate: prepared.sampleRate,
              playtime: prepared.playtimeMs,
            },
          };
          return await send.sendMessageItemWeixin({
            to,
            item,
            opts,
            label: 'sendVoiceMessageWeixin',
          });
        } finally {
          await prepared.cleanup();
        }
      };

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
        readFrameworkAllowFromList: pairing.readFrameworkAllowFromList,
        getContextToken: inbound.getContextToken,
        sendMessageWeixin: send.sendMessageWeixin,
        sendMessageItemWeixin: send.sendMessageItemWeixin,
        sendWeixinMediaFile: sendMedia.sendWeixinMediaFile,
        sendWeixinVoiceFile,
        version: packageJson.version ?? 'unknown',
        ilinkAppId: packageJson.ilink_appid ?? 'bot',
      };
    })();
  }
  return loaded;
}
