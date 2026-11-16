// Compat-layer modules import their small filesystem/identity helpers here so
// the A adapter and the transport layer share one implementation.
export {
  ensureDir,
  mediaKindFromMime,
  mimeFromPath,
  normalizeAccountId,
  readJson,
  safeFilename,
  writeJsonAtomic,
} from '../util.js';
