/**
 * Minimal typing-indicator helper. The Weixin plugin passes its own
 * sendTyping() calls as start/stop; we only own the keepalive interval.
 */
export function createTypingCallbacks(options = {}) {
  const {
    start,
    stop,
    onStartError,
    onStopError,
    keepaliveIntervalMs,
  } = options;

  let timer;
  let active = false;
  let chain = Promise.resolve();

  const run = (fn, onError) => {
    chain = chain
      .then(() => fn?.())
      .catch((error) => {
        try {
          onError?.(error);
        } catch {
          // best-effort
        }
      });
    return chain;
  };

  return {
    async start() {
      if (active) return;
      active = true;
      await run(start, onStartError);
      if (!active) return;
      if (Number.isFinite(keepaliveIntervalMs) && keepaliveIntervalMs > 0) {
        timer = setInterval(() => {
          void run(start, onStartError);
        }, keepaliveIntervalMs);
        timer.unref?.();
      }
    },
    async stop() {
      if (!active) return;
      active = false;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      await run(stop, onStopError);
    },
  };
}
