import assert from 'node:assert/strict';
import test from 'node:test';

import { createChannelRuntime } from '../src/compat/openclaw-runtime.js';

test('compat channelRuntime drives an inbound turn and delivers the reply', async () => {
  const delivered = [];
  let seen;
  const runtime = createChannelRuntime({
    stateDir: `/tmp/opencode/clawbot-compat-test-${process.pid}`,
    onInbound: async (message) => {
      seen = message;
      return { text: 'pong' };
    },
    log: () => {},
  });

  const { processOneMessage } = await import(
    '@tencent-weixin/openclaw-weixin/dist/src/messaging/process-message.js'
  );

  await processOneMessage(
    {
      from_user_id: 'u1@im.wechat',
      item_list: [{ type: 1, text_item: { text: 'ping' } }],
      context_token: 'ctx-token',
    },
    {
      accountId: 'acct',
      config: {},
      channelRuntime: {
        ...runtime,
        reply: {
          ...runtime.reply,
          createReplyDispatcherWithTyping: (opts) => {
            const inner = runtime.reply.createReplyDispatcherWithTyping({
              ...opts,
              deliver: async (payload) => delivered.push(payload),
            });
            return inner;
          },
        },
      },
      baseUrl: 'http://127.0.0.1',
      cdnBaseUrl: 'http://127.0.0.1',
      token: 'token',
      log: () => {},
      errLog: () => {},
    },
  );

  for (let i = 0; i < 50 && delivered.length === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  assert.equal(seen.text, 'ping');
  assert.equal(seen.userId, 'u1@im.wechat');
  assert.equal(seen.contextToken, 'ctx-token');
  assert.deepEqual(delivered, [{ text: 'pong' }]);
});
