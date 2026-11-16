import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeQrBaseUrl } from '../src/compat/login.js';

test('QR polling base URL only accepts Tencent HTTPS origins', () => {
  assert.equal(
    normalizeQrBaseUrl('https://ilinkai.weixin.qq.com/foo', 'https://ilinkai.weixin.qq.com'),
    'https://ilinkai.weixin.qq.com',
  );
  assert.equal(
    normalizeQrBaseUrl('https://sz.ilink.weixin.qq.com', 'https://ilinkai.weixin.qq.com'),
    'https://sz.ilink.weixin.qq.com',
  );
  assert.throws(() => normalizeQrBaseUrl('http://ilinkai.weixin.qq.com'), /https/);
  assert.throws(() => normalizeQrBaseUrl('https://127.0.0.1'), /not allowed/);
  assert.throws(() => normalizeQrBaseUrl('https://user:pass@ilinkai.weixin.qq.com'), /credentials/);
  assert.throws(() => normalizeQrBaseUrl('https://169.254.169.254'), /not allowed/);
});
