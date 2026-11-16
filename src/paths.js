import os from 'node:os';
import path from 'node:path';

export function resolveDshHome(configured) {
  const explicit = String(configured ?? '').trim();
  if (explicit) return path.resolve(explicit);
  const env = String(process.env.DSH_HOME ?? '').trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.dsh');
}

export function resolveStateDir(config = {}) {
  const configured = String(config.stateDir ?? '').trim();
  if (configured) return path.resolve(configured);
  return path.join(resolveDshHome(), 'clawbot');
}

export function resolveWorkspace(config = {}, stateDir) {
  const configured = String(config.workspace ?? '').trim();
  if (configured) return path.resolve(configured);
  return path.join(stateDir, 'workspace');
}
