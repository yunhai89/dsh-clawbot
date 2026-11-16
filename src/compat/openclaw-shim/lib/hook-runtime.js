/** We do not run OpenClaw's global plugin hook bus in the DSH bridge. */
export function fireAndForgetHook(promise) {
  Promise.resolve(promise).catch(() => {});
}

export function buildCanonicalSentMessageHookContext(input) {
  return input;
}

export function toPluginMessageContext(input) {
  return input;
}

export function toPluginMessageSentEvent(input) {
  return input;
}
