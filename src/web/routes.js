import crypto from 'node:crypto';
import QRCode from 'qrcode';

const PREFIX = '/api/dsh-clawbot';
const MAX_JSON_BODY_BYTES = 64 * 1024;

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

function isLoopbackHostname(hostname) {
  const value = String(hostname ?? '').toLowerCase();
  return (
    value === 'localhost' ||
    value === '::1' ||
    value === '[::1]' ||
    value === '127.0.0.1' ||
    /^127\./.test(value)
  );
}

function isLoopbackAddress(address) {
  const value = String(address ?? '');
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.') || value === '::ffff:127.0.0.1';
}

/**
 * Same-origin/local browser guard. QR login and logout are privileged local
 * operations; the DSH Web server is loopback-only by default.
 */
function isAllowed(req) {
  const host = req.headers.host;
  if (typeof host !== 'string' || !host) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  if (isLoopbackHostname(hostUrl.hostname)) return isLoopbackAddress(req.socket?.remoteAddress);
  const localAddress = req.socket?.localAddress;
  return typeof localAddress === 'string' && localAddress !== '0.0.0.0' && localAddress !== '::';
}

function guard(req, res, method = 'GET') {
  if (!isAllowed(req)) {
    writeJson(res, 403, { ok: false, error: 'local same-origin request required' });
    return false;
  }
  if (req.method !== method) {
    writeJson(res, 405, { ok: false, error: `method not allowed: ${req.method ?? ''}` });
    return false;
  }
  return true;
}

function toStatus(compat, adapter) {
  return {
    ok: true,
    transport: compat.status(),
    adapter: adapter.status(),
  };
}

export function createRoutes({ compat, adapter, allowDebug = false }) {
  const login = new Map();

  const makeQr = async (result) => {
    const payload = result.qrUrl || result.qrcode;
    const qrDataUrl = await QRCode.toDataURL(payload, {
      width: 320,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    });
    return { ...result, qrDataUrl, expiresAt: Date.now() + 5 * 60_000 };
  };

  return [
    {
      kind: 'exact',
      path: `${PREFIX}/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          writeJson(res, 200, toStatus(compat, adapter));
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/login/start`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const result = await compat.loginStart();
          login.set(result.qrcode, { createdAt: Date.now(), baseUrl: result.baseUrl });
          writeJson(res, 200, { ok: true, ...(await makeQr(result)) });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/login/status`,
      handler: async (req, res) => {
        if (!guard(req, res)) return;
        try {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
          const qrcode = url.searchParams.get('qrcode');
          if (!qrcode) {
            writeJson(res, 400, { ok: false, error: 'qrcode is required' });
            return;
          }
          const known = login.get(qrcode);
          const redirectHost = url.searchParams.get('redirectHost') ?? undefined;
          const baseUrl =
            url.searchParams.get('baseUrl') ??
            (redirectHost ? `https://${redirectHost}` : known?.baseUrl);
          const result = await compat.loginPoll({ qrcode, baseUrl });
          if (result.status === 'confirmed' || result.status === 'binded_redirect') {
            login.delete(qrcode);
          }
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    {
      kind: 'exact',
      path: `${PREFIX}/login/verify`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          const body = await readJsonBody(req);
          if (!body || typeof body.qrcode !== 'string') {
            writeJson(res, 400, { ok: false, error: 'malformed JSON body' });
            return;
          }
          const known = login.get(body.qrcode);
          const result = await compat.loginPoll({
            qrcode: body.qrcode,
            baseUrl: body.baseUrl || known?.baseUrl,
            verifyCode: typeof body.verifyCode === 'string' ? body.verifyCode : undefined,
          });
          if (result.status === 'confirmed' || result.status === 'binded_redirect') {
            login.delete(body.qrcode);
          }
          writeJson(res, 200, { ok: true, ...result });
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
    ...(allowDebug
      ? [
          {
            kind: 'exact',
            path: `${PREFIX}/debug/inbound`,
            handler: async (req, res) => {
              if (!guard(req, res, 'POST')) return;
              try {
                const body = await readJsonBody(req);
                if (!body || typeof body.text !== 'string') {
                  writeJson(res, 400, { ok: false, error: 'text is required' });
                  return;
                }
                const reply = await adapter.handleInbound({
                  accountId: String(body.accountId || 'debug-account'),
                  userId: String(body.userId || 'debug@im.wechat'),
                  messageId: crypto.randomUUID(),
                  text: body.text,
                  timestamp: Date.now(),
                });
                writeJson(res, 200, { ok: true, reply });
              } catch (error) {
                writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
              }
            },
          },
        ]
      : []),
    {
      kind: 'exact',
      path: `${PREFIX}/logout`,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return;
        try {
          await adapter.stop();
          await compat.logout();
          writeJson(res, 200, toStatus(compat, adapter));
        } catch (error) {
          writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    },
  ];
}
