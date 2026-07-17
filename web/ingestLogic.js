// web/ingestLogic.js — pure helpers for the W-UI §4 drag-and-drop ingest
// feature. Dependency-free (no DOM/fetch/SubtleCrypto) so this file's
// colocated ingestLogic.test.js can exercise it directly under vitest.
//
// `FINGERPRINT_CHUNK`/`fingerprintRanges` mirror src/ingest/locate.ts's
// exports of the same name — the daemon fingerprints a CANDIDATE file at the
// exact same byte ranges the browser fingerprinted the DROPPED file at, so
// the two must stay in sync (same duplication convention as spriteGeometryJS
// mirroring ops.ts's spriteGeometry).

/** Recognized camera-footage extensions (case-insensitive) — mirrors src/ingest/batch.ts's VIDEO_EXTENSIONS. */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

export function isVideoFileName(name) {
  const i = String(name ?? '').lastIndexOf('.');
  if (i < 0) return false;
  return VIDEO_EXTENSIONS.has(String(name).slice(i).toLowerCase());
}

export const FINGERPRINT_CHUNK = 1024 * 1024; // 1MB

/** Byte ranges to fingerprint for a file of `size` bytes — see src/ingest/locate.ts's fingerprintRanges (must stay in sync). */
export function fingerprintRanges(size) {
  const clamped = Math.max(0, size);
  const headLen = Math.min(FINGERPRINT_CHUNK, clamped);
  const tailLen = Math.min(FINGERPRINT_CHUNK, clamped);
  const tailStart = Math.max(0, clamped - tailLen);
  return { headStart: 0, headLen, tailStart, tailLen };
}

/** ArrayBuffer/Uint8Array -> lowercase hex string (SubtleCrypto's digest() result -> the hex the server compares against). */
export function bufferToHex(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** Human-readable byte size, e.g. "1.3 GB" — used in the plan-confirmation card ("件数+合計サイズ"). */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v < 10 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** Summary for the multi-file drop confirmation card: count + total size. */
export function planSummary(files) {
  const count = files.length;
  const totalBytes = files.reduce((sum, f) => sum + (f.size ?? 0), 0);
  return { count, totalBytes, totalBytesLabel: formatBytes(totalBytes) };
}
