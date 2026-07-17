import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * Drag-and-drop ingest ("link, don't copy" — see skill spec W-UI §4): the
 * browser only ever hands us a dropped file's name/size/content (never a
 * real filesystem path — that's sandboxed away from web pages), so finding
 * the ORIGINAL file on disk to link (instead of uploading a copy) needs a
 * name search + a content fingerprint to confirm the match:
 *
 *   1. `mdfind` by filename (macOS Spotlight index) for candidate paths.
 *   2. Narrow candidates to those whose size matches exactly.
 *   3. Confirm with a head+tail byte fingerprint (SHA-256 of the first and
 *      last FINGERPRINT_CHUNK bytes) against the one the browser computed
 *      client-side via SubtleCrypto (see web/ingestLogic.js's
 *      fingerprintRanges, which mirrors `fingerprintRanges` below).
 *
 * Never throws on a missing/failed `mdfind` (e.g. non-macOS, Spotlight
 * disabled) — locate is a best-effort convenience; the caller falls back to
 * an upload when nothing is found.
 */

export const FINGERPRINT_CHUNK = 1024 * 1024; // 1MB

export interface MediaFingerprint {
  size: number;
  headSha256: string;
  tailSha256: string;
}

/**
 * Byte ranges the head/tail fingerprint hashes are computed over, for a file
 * of `size` bytes. Shared convention with the browser client
 * (web/ingestLogic.js's fingerprintRanges) — the two MUST stay in sync, or
 * every candidate will fingerprint-mismatch. Small files (<= 2 * CHUNK)
 * naturally get overlapping/identical head+tail ranges, which is fine: the
 * hashes will simply agree trivially.
 */
export function fingerprintRanges(size: number): { headStart: number; headLen: number; tailStart: number; tailLen: number } {
  const clamped = Math.max(0, size);
  const headLen = Math.min(FINGERPRINT_CHUNK, clamped);
  const tailLen = Math.min(FINGERPRINT_CHUNK, clamped);
  const tailStart = Math.max(0, clamped - tailLen);
  return { headStart: 0, headLen, tailStart, tailLen };
}

/** Escape a literal for embedding inside an mdfind query STRING (not shell — execFile passes argv directly, so this is query-syntax hygiene, not a shell-injection guard). */
function escapeMdfindLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * `mdfind 'kMDItemFSName == "<name>"'`, invoked via execFile with the query
 * as a single argv element — no shell is ever spawned, so shell metachars in
 * `name` can't be used for injection. Returns an empty list (rather than
 * throwing) when mdfind is missing, disabled, or times out.
 */
export function mdfindByName(name: string, execFileImpl: typeof execFile = execFile): Promise<string[]> {
  return new Promise((resolve) => {
    const query = `kMDItemFSName == "${escapeMdfindLiteral(name)}"`;
    execFileImpl('mdfind', [query], { timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      resolve(
        String(stdout)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );
    });
  });
}

/**
 * Compute a candidate file's fingerprint IF its size matches `expectedSize`
 * exactly (the cheap filter from step 2 above) — returns null on a size
 * mismatch, a stat/read failure, or any other reason the file can't be used
 * (never throws, so one bad `mdfind` hit doesn't abort the whole search).
 */
export async function fingerprintFile(filePath: string, expectedSize: number): Promise<MediaFingerprint | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size !== expectedSize) return null;
  const { headStart, headLen, tailStart, tailLen } = fingerprintRanges(stat.size);
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const headBuf = Buffer.alloc(headLen);
    if (headLen > 0) await fh.read(headBuf, 0, headLen, headStart);
    const tailBuf = Buffer.alloc(tailLen);
    if (tailLen > 0) await fh.read(tailBuf, 0, tailLen, tailStart);
    return {
      size: stat.size,
      headSha256: createHash('sha256').update(headBuf).digest('hex'),
      tailSha256: createHash('sha256').update(tailBuf).digest('hex'),
    };
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

export function fingerprintsMatch(a: MediaFingerprint, b: MediaFingerprint): boolean {
  return a.size === b.size && a.headSha256 === b.headSha256 && a.tailSha256 === b.tailSha256;
}

/**
 * Locate a dropped file on this machine by name + content fingerprint.
 * Returns the first matching absolute path, or null if nothing on disk
 * matches (caller falls back to /api/upload).
 */
export async function locateMedia(
  name: string,
  target: MediaFingerprint,
  deps: { mdfind?: typeof mdfindByName; fingerprint?: typeof fingerprintFile } = {},
): Promise<string | null> {
  const mdfind = deps.mdfind ?? mdfindByName;
  const fingerprint = deps.fingerprint ?? fingerprintFile;
  const candidates = await mdfind(name);
  for (const candidatePath of candidates) {
    const fp = await fingerprint(candidatePath, target.size);
    if (fp && fingerprintsMatch(fp, target)) return candidatePath;
  }
  return null;
}
