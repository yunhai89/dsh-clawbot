import assert from 'node:assert/strict';
import test from 'node:test';

import { OpenClawCompat } from '../src/compat/index.js';

function makeCompat({ voiceFails = false, fileFails = false } = {}) {
  const calls = [];
  const compat = Object.create(OpenClawCompat.prototype);
  compat.cfg = {};
  compat.log = (message) => calls.push({ type: 'log', message });
  compat.init = async () => {};
  compat.api = {
    resolveWeixinAccount: () => ({
      configured: true,
      accountId: 'acct',
      baseUrl: 'https://example.invalid',
      token: 'token',
      cdnBaseUrl: 'https://cdn.example.invalid',
    }),
    getContextToken: () => 'context',
    sendMessageWeixin: async ({ text }) => {
      calls.push({ type: 'text', text });
      return { messageId: 'text-1' };
    },
    sendWeixinVoiceFile: async ({ filePath }) => {
      calls.push({ type: 'voice', filePath });
      if (voiceFails) throw new Error('voice rejected');
      return { messageId: 'voice-1' };
    },
    sendWeixinMediaFile: async ({ filePath, text }) => {
      calls.push({ type: 'file', filePath, text });
      if (fileFails) throw new Error('file rejected');
      return { messageId: 'file-1' };
    },
  };
  return { compat, calls };
}

test('compat send routes voice paths through the native voice sender', async () => {
  const { compat, calls } = makeCompat();
  const result = await compat.send({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    text: 'caption',
    voicePath: '/workspace/a.silk',
  });
  assert.equal(result.messageId, 'voice-1');
  assert.deepEqual(
    calls.map((call) => call.type),
    ['text', 'voice'],
  );
});

test('compat send falls back to a file when native voice fails', async () => {
  const { compat, calls } = makeCompat({ voiceFails: true });
  const result = await compat.send({
    accountId: 'acct',
    userId: 'u1@im.wechat',
    text: 'caption',
    voicePath: '/workspace/a.mp3',
  });
  assert.equal(result.messageId, 'file-1');
  assert.deepEqual(
    calls.map((call) => call.type),
    ['text', 'voice', 'log', 'file'],
  );
  assert.match(calls[2].message, /falling back to file/);
  assert.equal(calls[3].filePath, '/workspace/a.mp3');
  assert.equal(calls[3].text, '');
});
