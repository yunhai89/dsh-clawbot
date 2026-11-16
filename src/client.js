window.__ModuleLoader__.load({
  id: 'dsh-clawbot',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');
    const { useCallback, useEffect, useState } = React;
    const API = '/api/dsh-clawbot';
    const h = React.createElement;

    const styles = {
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '4px 0 8px',
        maxWidth: 520,
        fontFamily: 'inherit',
        fontSize: 13,
        lineHeight: 1.55,
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
      },
      title: { fontWeight: 600, fontSize: 14 },
      muted: { opacity: 0.68 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      button: {
        appearance: 'none',
        border: '1px solid currentColor',
        borderRadius: 8,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
        padding: '5px 12px',
        opacity: 0.9,
      },
      primary: {
        border: '1px solid transparent',
        background: '#4f46e5',
        color: '#fff',
      },
      qrBox: {
        alignSelf: 'flex-start',
        background: '#fff',
        borderRadius: 12,
        padding: 12,
        boxShadow: '0 1px 8px rgba(0,0,0,.18)',
      },
      qr: { display: 'block', width: 220, height: 220 },
      error: { color: '#dc2626', whiteSpace: 'pre-wrap' },
      ok: { color: '#16a34a' },
      code: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      input: {
        border: '1px solid currentColor',
        borderRadius: 8,
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        padding: '5px 10px',
        width: 150,
      },
      list: { margin: 0, paddingLeft: 18 },
    };

    async function request(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        ...options,
        headers: {
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...(options.headers || {}),
        },
      });
      let body = {};
      try {
        body = await response.json();
      } catch {
        // ignore non-JSON
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      return body;
    }

    function Card() {
      const [status, setStatus] = useState(null);
      const [qr, setQr] = useState(null);
      const [login, setLogin] = useState(null);
      const [verifyCode, setVerifyCode] = useState('');
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);

      const refresh = useCallback(async () => {
        try {
          const body = await request('/status');
          setStatus(body);
          setError('');
        } catch (err) {
          setError(err?.message || String(err));
        }
      }, []);

      useEffect(() => {
        void refresh();
        const timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') void refresh();
        }, 4000);
        return () => clearInterval(timer);
      }, [refresh]);

      const startLogin = useCallback(async () => {
        setBusy(true);
        setError('');
        setLogin(null);
        setVerifyCode('');
        try {
          const body = await request('/login/start', { method: 'POST' });
          setQr(body);
        } catch (err) {
          setError(err?.message || String(err));
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        if (!qr?.qrcode) return undefined;
        let cancelled = false;
        let baseUrl = qr.baseUrl;
        const tick = async () => {
          if (document.visibilityState === 'hidden') return;
          try {
            const params = new URLSearchParams({ qrcode: qr.qrcode });
            if (baseUrl) params.set('baseUrl', baseUrl);
            const body = await request(`/login/status?${params.toString()}`);
            if (cancelled) return;
            setLogin(body);
            if (body.status === 'confirmed' || body.status === 'binded_redirect') {
              setQr(null);
              setLogin(null);
              await refresh();
              return;
            }
            if (body.status === 'expired' || body.status === 'verify_code_blocked') {
              setError(body.message || '二维码已过期，请重新获取。');
              setQr(null);
              return;
            }
            if (body.status === 'scaned_but_redirect' && body.redirectHost) {
              baseUrl = `https://${body.redirectHost}`;
            }
          } catch (err) {
            if (!cancelled) setError(err?.message || String(err));
          }
        };
        void tick();
        const timer = setInterval(() => void tick(), 2000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [qr, refresh]);

      const submitVerify = useCallback(async () => {
        if (!qr?.qrcode || !verifyCode.trim()) return;
        setBusy(true);
        setError('');
        try {
          const body = await request('/login/verify', {
            method: 'POST',
            body: JSON.stringify({
              qrcode: qr.qrcode,
              baseUrl: qr.baseUrl,
              verifyCode: verifyCode.trim(),
            }),
          });
          setLogin(body);
          if (body.status === 'confirmed' || body.status === 'binded_redirect') {
            setQr(null);
            setLogin(null);
            await refresh();
          }
        } catch (err) {
          setError(err?.message || String(err));
        } finally {
          setBusy(false);
        }
      }, [qr, verifyCode, refresh]);

      const logout = useCallback(async () => {
        if (!window.confirm('确定要退出微信 ClawBot 登录？这会删除本机保存的 bot token。')) return;
        setBusy(true);
        setError('');
        try {
          await request('/logout', {
            method: 'POST',
            body: JSON.stringify({ confirm: true }),
          });
          setQr(null);
          setLogin(null);
          await refresh();
        } catch (err) {
          setError(err?.message || String(err));
        } finally {
          setBusy(false);
        }
      }, [refresh]);

      const transport = status?.transport;
      const accounts = transport?.accounts ?? [];
      const connected = Boolean(transport?.connected);
      const loginState = login?.status;
      const hint =
        loginState === 'scaned'
          ? '已扫码，请在手机上确认。'
          : loginState === 'need_verifycode'
            ? '手机微信要求输入数字验证码。'
            : qr
              ? '请用手机微信扫描二维码。'
              : connected
                ? '微信已连接。'
                : '还没有连接微信。';

      return h(
        'div',
        { style: styles.card },
        h(
          'div',
          { style: styles.header },
          h('div', { style: styles.title }, '微信 ClawBot'),
          h(
            'span',
            { style: connected ? styles.ok : styles.muted },
            connected ? '已连接' : status ? '未连接' : '加载中…',
          ),
        ),

        h('div', { style: styles.muted }, hint),

        connected &&
          h(
            'ul',
            { style: styles.list },
            accounts.map((account) =>
              h(
                'li',
                { key: account.accountId, style: styles.code },
                `${account.accountId}${account.userId ? ` · ${account.userId}` : ''}${account.running ? ' · 运行中' : ''}`,
              ),
            ),
          ),

        transport?.lastError && h('div', { style: styles.error }, transport.lastError),
        error && h('div', { style: styles.error }, error),

        qr &&
          h(
            'div',
            { style: styles.row },
            h('div', { style: styles.qrBox }, h('img', { src: qr.qrDataUrl, alt: 'ClawBot QR', style: styles.qr })),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 220 } },
              h('div', { style: styles.muted }, '手机微信 → 我 → 设置 → 插件 → ClawBot，然后扫描二维码。'),
              h(
                'button',
                { type: 'button', style: styles.button, onClick: startLogin, disabled: busy },
                '刷新二维码',
              ),
            ),
          ),

        loginState === 'need_verifycode' &&
          h(
            'div',
            { style: styles.row },
            h('input', {
              style: styles.input,
              value: verifyCode,
              inputMode: 'numeric',
              placeholder: '数字验证码',
              onChange: (event) => setVerifyCode(event.target.value),
            }),
            h(
              'button',
              { type: 'button', style: styles.button, onClick: submitVerify, disabled: busy },
              '提交验证码',
            ),
          ),

        h(
          'div',
          { style: styles.row },
          !qr &&
            h(
              'button',
              {
                type: 'button',
                style: { ...styles.button, ...(connected ? {} : styles.primary) },
                onClick: startLogin,
                disabled: busy,
              },
              connected ? '重新扫码' : '扫码登录',
            ),
          connected &&
            h(
              'button',
              { type: 'button', style: styles.button, onClick: logout, disabled: busy },
              '退出登录',
            ),
          h(
            'button',
            { type: 'button', style: styles.button, onClick: refresh, disabled: busy },
            '刷新状态',
          ),
        ),

        status?.adapter?.sessions?.length
          ? h('div', { style: styles.muted }, `当前微信会话：${status.adapter.sessions.length}`)
          : null,
      );
    }

    function summaryText() {
      return '微信 ClawBot';
    }

    function apply(ctx) {
      const register = (seat, key) =>
        ctx.slots.inject(seat, () =>
          ctx.slots.register({ name: seat, key }, (slotProps) =>
            slotProps && slotProps.view === 'summary'
              ? summaryText()
              : h(Card),
          ),
        );

      register('plugins.row.config', 'dsh-clawbot#clawbot');
      register('plugins.bundle.config', 'dsh-clawbot');
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    return module.exports;
  },
});
