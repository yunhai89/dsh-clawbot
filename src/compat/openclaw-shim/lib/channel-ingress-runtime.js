/**
 * The Weixin plugin asks this helper to decide whether a direct-message sender
 * may reach the agent. OpenClaw's real implementation is a pairing/allowlist
 * state machine; for the DSH bridge we enforce a strict allowlist that the
 * compat layer writes after QR login.
 */
export async function resolveChannelMessageIngress(params) {
  if (params?.policy?.dmPolicy === 'disabled') {
    return {
      senderAccess: { allowed: false, reason: 'dm-disabled' },
      commandAccess: { authorized: false },
    };
  }

  const senderId = String(params?.subject?.stableId ?? '');
  let allowFrom = [];
  try {
    const value = await params?.readStoreAllowFrom?.();
    if (Array.isArray(value)) allowFrom = value.map(String).filter(Boolean);
  } catch {
    allowFrom = [];
  }

  // Legacy accounts without an allowlist keep OpenClaw's historical behaviour.
  // The compat layer always writes the QR owner into the allowlist, so normal
  // production traffic takes the explicit branch below.
  const allowed = allowFrom.length === 0 || allowFrom.includes(senderId);
  const commandRequested = Boolean(params?.command?.allowTextCommands);

  return {
    senderAccess: { allowed },
    commandAccess: { authorized: allowed && commandRequested },
  };
}
