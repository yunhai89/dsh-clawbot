import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveOpenClawConfigPath() {
  const explicit = process.env.OPENCLAW_CONFIG?.trim();
  if (explicit) return explicit;
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(os.homedir(), '.openclaw');
  return path.join(stateDir, 'openclaw.json');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Minimal implementation of OpenClaw's config mutation helper. The Weixin
 * plugin only uses it to bump `channels.openclaw-weixin.channelConfigUpdatedAt`
 * after a successful QR login.
 */
export async function mutateConfigFile({ mutate }) {
  const filePath = resolveOpenClawConfigPath();
  const draft = readJson(filePath);
  await mutate(draft);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
  return draft;
}
