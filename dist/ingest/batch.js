import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { needsColorTransform, COLOR_WARNING_MESSAGE } from '../core/ops.js';
import { probe, sha256File } from './ingest.js';
// ---- scanning ----
/**
 * Recognized footage extensions (case-insensitive) for directory scans.
 *
 * Keep this aligned with web/ingestLogic.js. Ingest itself is ffprobe-based
 * and already supports these containers; filtering the directory/drop path
 * to Apple camera extensions made perfectly usable stock-site WebM/Ogg files
 * disappear without an error.
 */
export const VIDEO_EXTENSIONS = new Set([
    '.mp4', '.mov', '.m4v',
    '.mkv', '.webm', '.avi',
    '.mts', '.m2ts',
    '.mpg', '.mpeg',
    '.ogv',
]);
function isVideoFile(name) {
    return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}
/**
 * Recursively list video files under `dir`, skipping dotfiles/dot-directories
 * (e.g. `.DS_Store`, `.Trash`, hidden AVCHD sidecar dirs). Sorted for
 * deterministic base ordering before the creation-time sort in
 * `sortByCreationTime` — this is just "found order", not the ingest order.
 */
async function walkVideoFiles(dir) {
    const out = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        if (e.name.startsWith('.'))
            continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await walkVideoFiles(full)));
        }
        else if (e.isFile() && isVideoFile(e.name)) {
            out.push(full);
        }
    }
    return out.sort();
}
/**
 * Resolve `ingest-batch`'s `<dir|files...>` positional argument to an
 * absolute file list. A single directory argument is scanned recursively
 * for video files (see `walkVideoFiles`); anything else (one or more
 * explicit file paths) is used as-given — no extension filtering, since the
 * user named these files directly — but each must exist.
 */
export async function listVideoFiles(targets) {
    if (targets.length === 1) {
        let stat = null;
        try {
            stat = await fs.stat(targets[0]);
        }
        catch { /* not a path that exists as given; fall through to file-list handling below */ }
        if (stat?.isDirectory()) {
            return walkVideoFiles(path.resolve(targets[0]));
        }
    }
    const out = [];
    for (const t of targets) {
        const abs = path.resolve(t);
        await fs.access(abs); // throws ENOENT with a clear message if missing
        out.push(abs);
    }
    return out;
}
// ---- plan (read-only pre-scan) ----
const KNOWN_SDR_CODECS = new Set(['h264', 'hevc']);
/** Whether ffprobe's avg vs nominal frame rate disagree enough to suspect VFR footage. */
export function isVfrSuspect(fps, rFps) {
    if (rFps === undefined)
        return false;
    return Math.abs(fps - rFps) > 0.5;
}
export async function probeForPlan(file) {
    const [p, stat] = await Promise.all([probe(file), fs.stat(file)]);
    const warnings = [];
    if (p.codec && !KNOWN_SDR_CODECS.has(p.codec)) {
        warnings.push({ code: 'codec', message: `非H.264/HEVCコーデック (${p.codec}) — レンダー時に変換が必要な場合があります` });
    }
    if (isVfrSuspect(p.fps, p.rFps)) {
        warnings.push({
            code: 'vfr',
            message: `可変フレームレートの疑い (avg ${p.fps.toFixed(2)}fps / nominal ${p.rFps.toFixed(2)}fps)`,
        });
    }
    if (!p.hasAudio) {
        warnings.push({ code: 'no-audio', message: '音声トラックなし' });
    }
    if (needsColorTransform(p.color)) {
        warnings.push({ code: 'color', message: COLOR_WARNING_MESSAGE });
    }
    return {
        file,
        size: stat.size,
        duration: p.duration,
        fps: p.fps,
        width: p.width,
        height: p.height,
        hasAudio: p.hasAudio,
        codec: p.codec,
        color: p.color,
        creationTime: p.creationTime,
        warnings,
    };
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Probe every file (sequentially — ffprobe is cheap; the slow work is proxy/transcribe, not scanning) and aggregate totals. */
export async function buildPlan(files) {
    const entries = [];
    for (const f of files)
        entries.push(await probeForPlan(f));
    return {
        entries,
        fileCount: entries.length,
        totalSize: entries.reduce((a, e) => a + e.size, 0),
        totalDuration: entries.reduce((a, e) => a + e.duration, 0),
    };
}
/**
 * Probe every selected file without letting one corrupt/unreadable container
 * hide the usable remainder of the batch. The caller can journal/report each
 * `probe` failure while continuing with `entries`.
 */
export async function buildPlanSettled(files) {
    const entries = [];
    const failures = [];
    for (const file of files) {
        try {
            entries.push(await probeForPlan(file));
        }
        catch (error) {
            failures.push({ file, stage: 'probe', error: errorMessage(error) });
        }
    }
    return {
        entries,
        failures,
        fileCount: entries.length,
        totalSize: entries.reduce((a, e) => a + e.size, 0),
        totalDuration: entries.reduce((a, e) => a + e.duration, 0),
    };
}
/**
 * Order entries by shooting time (format.tags.creation_time), falling back
 * to filesystem mtime for files whose container carries no creation_time —
 * still deterministic, just not shooting-order for those specific files.
 */
export async function sortByCreationTime(entries) {
    const keyed = await Promise.all(entries.map(async (entry) => ({
        entry,
        key: entry.creationTime ?? (await fs.stat(entry.file)).mtime.toISOString(),
    })));
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return keyed.map((k) => k.entry);
}
/**
 * Split a hashed file list into unique files to ingest and duplicates to
 * skip. `existingBySha` wins over batch-internal duplicates (checked
 * first): if a file matches BOTH an existing source and an earlier file in
 * this batch, it's reported against the existing source, since that's the
 * more actionable fact ("already in the project") for the caller.
 */
export function detectDuplicates(fileHashes, existingBySha) {
    const seenInBatch = new Map(); // hash -> first file with it
    const unique = [];
    const duplicates = [];
    for (const { file, hash } of fileHashes) {
        const existingSourceId = existingBySha.get(hash);
        if (existingSourceId) {
            duplicates.push({ file, hash, kind: 'existing', duplicateOf: existingSourceId });
            continue;
        }
        const firstInBatch = seenInBatch.get(hash);
        if (firstInBatch) {
            duplicates.push({ file, hash, kind: 'batch', duplicateOf: firstInBatch });
            continue;
        }
        seenInBatch.set(hash, file);
        unique.push({ file, hash });
    }
    return { unique, duplicates };
}
/**
 * A path is safe to resume-skip only when its current bytes match the bytes
 * that were actually ingested. Path identity alone is insufficient: camera
 * cards and download folders routinely reuse filenames.
 *
 * `currentHash` is intentionally required. Under `--no-verify` the caller
 * passes no hash and retries the file rather than making an unsafe skip.
 */
export function canResumeSkip(entry, currentHash) {
    return Boolean(entry?.status === 'ingested'
        && entry.sha256
        && currentHash
        && entry.sha256 === currentHash);
}
export function journalPath(dir) {
    return path.join(dir, 'ingest-journal.json');
}
export async function readJournal(dir) {
    try {
        const raw = await fs.readFile(journalPath(dir), 'utf8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return []; // no journal yet (first run) or unreadable; start fresh
    }
}
async function writeJournal(dir, entries) {
    const tmp = `${journalPath(dir)}.tmp-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
    await fs.rename(tmp, journalPath(dir));
}
/**
 * In-process, lock-serialized journal writer. `ingest-batch` processes up to
 * two files concurrently (see `runPool`), each recording several status
 * transitions (planned -> copied -> ingested/failed); without serializing,
 * two concurrent read-modify-write cycles on the same journal file could
 * race and silently drop one file's update (same class of bug `Project`'s
 * `withLock` exists to prevent — see core/project.ts). `record` always
 * resolves only after its write has landed on disk, so a caller that awaits
 * it can rely on the journal reflecting that status if the process dies
 * right after.
 */
export function createJournal(dir, initial) {
    let entries = [...initial];
    let chain = Promise.resolve();
    function record(entry) {
        // A prior record() in the chain failing (e.g. disk full) must not wedge
        // every subsequent call — swallow it here so the chain keeps going;
        // the caller of the FAILING call still sees its own rejection below.
        const recoverPriorFailure = () => undefined;
        chain = chain.then(async () => {
            const idx = entries.findIndex((e) => e.file === entry.file);
            if (idx >= 0)
                entries = [...entries.slice(0, idx), entry, ...entries.slice(idx + 1)];
            else
                entries = [...entries, entry];
            await writeJournal(dir, entries);
        }, recoverPriorFailure);
        return chain;
    }
    return {
        record,
        get entries() {
            return entries;
        },
    };
}
// ---- copy mode ----
/** Copy `src` into `destDir` without hash verification (used only with `--no-verify --copy`). */
export async function copyPlain(src, destDir) {
    await fs.mkdir(destDir, { recursive: true });
    const { name, ext } = path.parse(path.basename(src));
    for (let n = 0;; n++) {
        const dest = path.join(destDir, n === 0 ? `${name}${ext}` : `${name}-${n}${ext}`);
        try {
            // COPYFILE_EXCL combines reservation + copy in the filesystem. A
            // separate access() check leaves a race where two concurrent workers
            // choose the same free basename and one silently overwrites the other.
            await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL);
            return dest;
        }
        catch (error) {
            if (error?.code === 'EEXIST')
                continue;
            throw error;
        }
    }
}
/**
 * Copy `src` into `destDir`, then re-hash the COPY and compare against
 * `expectedHash` (the source's already-computed SHA-256). A mismatch means
 * the copy is corrupt (bad media, interrupted write, failing storage) — the
 * partial/bad copy is removed and an error thrown so the caller can fail
 * that file without ingesting silently-corrupted footage.
 */
export async function copyAndVerify(src, destDir, expectedHash) {
    const dest = await copyPlain(src, destDir);
    const actual = await sha256File(dest);
    if (actual !== expectedHash) {
        await fs.rm(dest, { force: true });
        throw new Error(`copy verification failed for ${src}: expected sha256 ${expectedHash}, got ${actual}`);
    }
    return dest;
}
/**
 * Reuse a prior verified `--copy` result after the later ingest stage failed
 * or the process stopped. This prevents every retry from creating
 * `clip-1.mp4`, `clip-2.mp4`, ... while still refusing path-only trust: the
 * original bytes, journal hash, destination bytes, and canonical copy root
 * must all agree. A mismatch is non-destructive and simply asks the caller
 * to make a fresh exclusive copy.
 */
export async function reusableVerifiedCopy(entry, destDir, currentHash) {
    if (!entry?.destPath || !entry.sha256 || !currentHash || entry.sha256 !== currentHash)
        return null;
    try {
        const [realRoot, realDest, stat] = await Promise.all([
            fs.realpath(path.resolve(destDir)),
            fs.realpath(path.resolve(entry.destPath)),
            fs.lstat(path.resolve(entry.destPath)),
        ]);
        if (!stat.isFile() || stat.isSymbolicLink())
            return null;
        const relative = path.relative(realRoot, realDest);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
            return null;
        return (await sha256File(realDest)) === currentHash ? path.resolve(entry.destPath) : null;
    }
    catch {
        return null;
    }
}
export async function runPool(items, concurrency, worker) {
    let next = 0;
    const failures = [];
    const workerCount = Math.max(1, Math.min(concurrency, items.length));
    const lanes = Array.from({ length: workerCount }, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length)
                return;
            try {
                await worker(items[i], i);
            }
            catch (error) {
                // A rejected item must not make Promise.all return while sibling
                // lanes are still mutating media/journal state. Record it, keep this
                // lane useful, and return all failures only after every item settles.
                failures.push({ item: items[i], index: i, error });
            }
        }
    });
    await Promise.all(lanes);
    return failures.sort((a, b) => a.index - b.index);
}
