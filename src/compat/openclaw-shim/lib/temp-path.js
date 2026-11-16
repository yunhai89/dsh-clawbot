import os from 'node:os';
import path from 'node:path';

/** The Weixin plugin logs into `<tmp>/openclaw/openclaw-YYYY-MM-DD.log`. */
export function resolvePreferredOpenClawTmpDir() {
  return process.env.OPENCLAW_TMP_DIR?.trim() || path.join(os.tmpdir(), 'openclaw');
}
