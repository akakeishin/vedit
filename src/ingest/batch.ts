import { promises as fs } from 'node:fs';
import path from 'node:path';
import { needsColorTransform, COLOR_WARNING_MESSAGE } from '../core/ops.js';
import type { Source } from '../core/types.js';
import { probe, sha256File } from './ingest.js';

// ---- scanning ----

/** Recognized camera-footage extensions (case-insensitive) for directory scans. */
export const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);

function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/**
 * Recursively list video files under `dir`, skipping dotfiles/dot-directories
 * (e.g. `.DS_Store`, `.Trash`, hidden AVCHD sidecar dirs). Sorted for
 * deterministic base ordering before the creation-time sort in
 * `sortByCreationTime` — this is just "found order", not the ingest order.
 */
async function walkVideoFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walkVideoFiles(full)));
    } else if (e.isFile() && isVideoFile(e.name)) {
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
export async function listVideoFiles(targets: string[]): Promise<string[]> {
  if (targets.length === 1) {
    let stat: import('node:fs').Stats | null = null;
    try {
      stat = await fs.stat(targets[0]);
    } catch { /* not a path that exists as given; fall through to file-list handling below */ }
    if (stat?.isDirectory()) {
      return walkVideoFiles(path.resolve(targets[0]));
    }
  }
  const out: string[] = [];
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
export function isVfrSuspect(fps: number, rFps?: number): boolean {
  if (rFps === undefined) return false;
  return Math.abs(fps - rFps) > 0.5;
}

export interface PlanWarning {
  code: 'codec' | 'vfr' | 'no-audio' | 'color';
  message: string;
}

export interface PlanEntry {
  file: string;
  size: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  codec?: string;
  color?: Source['color'];
  creationTime?: string;
  warnings: PlanWarning[];
}

export async function probeForPlan(file: string): Promise<PlanEntry> {
  const [p, stat] = await Promise.all([probe(file), fs.stat(file)]);
  const warnings: PlanWarning[] = [];
  if (p.codec && !KNOWN_SDR_CODECS.has(p.codec)) {
    warnings.push({ code: 'codec', message: `非H.264/HEVCコーデック (${p.codec}) — レンダー時に変換が必要な場合があります` });
  }
  if (isVfrSuspect(p.fps, p.rFps)) {
    warnings.push({
      code: 'vfr',
      message: `可変フレームレートの疑い (avg ${p.fps.toFixed(2)}fps / nominal ${p.rFps!.toFixed(2)}fps)`,
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

export interface IngestPlan {
  entries: PlanEntry[];
  fileCount: number;
  totalSize: number;
  totalDuration: number;
}

/** Probe every file (sequentially — ffprobe is cheap; the slow work is proxy/transcribe, not scanning) and aggregate totals. */
export async function buildPlan(files: string[]): Promise<IngestPlan> {
  const entries: PlanEntry[] = [];
  for (const f of files) entries.push(await probeForPlan(f));
  return {
    entries,
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
export async function sortByCreationTime(entries: PlanEntry[]): Promise<PlanEntry[]> {
  const keyed = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      key: entry.creationTime ?? (await fs.stat(entry.file)).mtime.toISOString(),
    })),
  );
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return keyed.map((k) => k.entry);
}

// ---- duplicate detection ----

export interface DuplicateResult {
  file: string;
  hash: string;
  /** 'batch' = same hash as an earlier file in this run; 'existing' = matches a source already in the project. */
  kind: 'batch' | 'existing';
  /** The file path (kind='batch') or sourceId (kind='existing') this duplicates. */
  duplicateOf: string;
}

/**
 * Split a hashed file list into unique files to ingest and duplicates to
 * skip. `existingBySha` wins over batch-internal duplicates (checked
 * first): if a file matches BOTH an existing source and an earlier file in
 * this batch, it's reported against the existing source, since that's the
 * more actionable fact ("already in the project") for the caller.
 */
export function detectDuplicates(
  fileHashes: { file: string; hash: string }[],
  existingBySha: Map<string, string>,
): { unique: { file: string; hash: string }[]; duplicates: DuplicateResult[] } {
  const seenInBatch = new Map<string, string>(); // hash -> first file with it
  const unique: { file: string; hash: string }[] = [];
  const duplicates: DuplicateResult[] = [];
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

// ---- processing journal (<project>/ingest-journal.json) ----

export interface IngestJournalEntry {
  /** Absolute path of the ORIGINAL source file (never the --copy destination) — the resume key. */
  file: string;
  sha256?: string;
  status: 'planned' | 'copied' | 'ingested' | 'failed';
  /** Set once --copy has placed a verified copy on disk. */
  destPath?: string;
  error?: string;
  at: string;
}

export function journalPath(dir: string): string {
  return path.join(dir, 'ingest-journal.json');
}

export async function readJournal(dir: string): Promise<IngestJournalEntry[]> {
  try {
    const raw = await fs.readFile(journalPath(dir), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // no journal yet (first run) or unreadable; start fresh
  }
}

async function writeJournal(dir: string, entries: IngestJournalEntry[]): Promise<void> {
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
export function createJournal(dir: string, initial: IngestJournalEntry[]) {
  let entries = [...initial];
  let chain: Promise<unknown> = Promise.resolve();
  function record(entry: IngestJournalEntry): Promise<void> {
    chain = chain.then(
      async () => {
        const idx = entries.findIndex((e) => e.file === entry.file);
        if (idx >= 0) entries = [...entries.slice(0, idx), entry, ...entries.slice(idx + 1)];
        else entries = [...entries, entry];
        await writeJournal(dir, entries);
      },
      // A prior record() in the chain failing (e.g. disk full) must not wedge
      // every subsequent call — swallow it here so the chain keeps going;
      // the caller of the FAILING call still sees its own rejection below.
      () => undefined,
    );
    return chain as Promise<void>;
  }
  return {
    record,
    get entries() {
      return entries;
    },
  };
}

// ---- copy mode ----

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function uniqueDestPath(destDir: string, base: string): Promise<string> {
  let candidate = path.join(destDir, base);
  if (!(await pathExists(candidate))) return candidate;
  const { name, ext } = path.parse(base);
  for (let n = 1; ; n++) {
    candidate = path.join(destDir, `${name}-${n}${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
}

/** Copy `src` into `destDir` without hash verification (used only with `--no-verify --copy`). */
export async function copyPlain(src: string, destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true });
  const dest = await uniqueDestPath(destDir, path.basename(src));
  await fs.copyFile(src, dest);
  return dest;
}

/**
 * Copy `src` into `destDir`, then re-hash the COPY and compare against
 * `expectedHash` (the source's already-computed SHA-256). A mismatch means
 * the copy is corrupt (bad media, interrupted write, failing storage) — the
 * partial/bad copy is removed and an error thrown so the caller can abort
 * rather than ingest silently-corrupted footage.
 */
export async function copyAndVerify(src: string, destDir: string, expectedHash: string): Promise<string> {
  const dest = await copyPlain(src, destDir);
  const actual = await sha256File(dest);
  if (actual !== expectedHash) {
    await fs.rm(dest, { force: true });
    throw new Error(`copy verification failed for ${src}: expected sha256 ${expectedHash}, got ${actual}`);
  }
  return dest;
}

// ---- bounded parallelism ----

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Used to cap proxy-generation + transcription (the expensive part of each
 * /api/ingest call) at 2 concurrent files, per the ingest-batch spec —
 * unbounded parallelism here would spawn N whisper-cli/ffmpeg processes at
 * once for a big camera-card dump.
 */
export async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const lanes = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
}
