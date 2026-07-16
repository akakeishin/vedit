import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// probeForPlan/buildPlan shell out via ffprobe (run() in run.js); stub it so
// these tests only assert on planning logic, without needing ffmpeg/ffprobe
// installed (same approach as ingest.test.ts).
const { runMock } = vi.hoisted(() => ({ runMock: vi.fn() }));
vi.mock('./run.js', () => ({
  run: (...args: unknown[]) => runMock(...args),
  runBinary: vi.fn(),
}));

import {
  copyAndVerify,
  copyPlain,
  createJournal,
  detectDuplicates,
  isVfrSuspect,
  journalPath,
  listVideoFiles,
  probeForPlan,
  readJournal,
  runPool,
  sortByCreationTime,
  VIDEO_EXTENSIONS,
  type IngestJournalEntry,
} from './batch.js';
import { sha256File } from './ingest.js';

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function ffprobeJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: { duration: '10', tags: {} },
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        avg_frame_rate: '30/1',
        r_frame_rate: '30/1',
        width: 1920,
        height: 1080,
        duration: '10',
      },
      { codec_type: 'audio' },
    ],
    ...overrides,
  });
}

describe('listVideoFiles', () => {
  it('recursively scans a single directory for video extensions, skipping dotfiles/dot-dirs', async () => {
    const root = tmpDir('vedit-batch-scan-');
    await fs.writeFile(path.join(root, 'a.mp4'), 'a');
    await fs.writeFile(path.join(root, 'b.MOV'), 'b'); // case-insensitive
    await fs.writeFile(path.join(root, 'notes.txt'), 'x'); // wrong extension
    await fs.writeFile(path.join(root, '.hidden.mp4'), 'h'); // dotfile
    await fs.mkdir(path.join(root, '.hiddenDir'));
    await fs.writeFile(path.join(root, '.hiddenDir', 'c.mp4'), 'c');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'd.m4v'), 'd');

    const files = await listVideoFiles([root]);
    const names = files.map((f) => path.basename(f)).sort();
    expect(names).toEqual(['a.mp4', 'b.MOV', 'd.m4v']);
  });

  it('treats multiple positional args as an explicit file list (no extension filtering)', async () => {
    const root = tmpDir('vedit-batch-files-');
    const f1 = path.join(root, 'clip1.mp4');
    const f2 = path.join(root, 'clip2.weird');
    await fs.writeFile(f1, 'a');
    await fs.writeFile(f2, 'b');
    const files = await listVideoFiles([f1, f2]);
    expect(files.sort()).toEqual([f1, f2].sort());
  });

  it('throws when an explicit file does not exist', async () => {
    const root = tmpDir('vedit-batch-missing-');
    await expect(listVideoFiles([path.join(root, 'nope.mp4')])).rejects.toThrow();
  });

  it('exposes the recognized extension set', () => {
    expect(VIDEO_EXTENSIONS.has('.mp4')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('.mov')).toBe(true);
    expect(VIDEO_EXTENSIONS.has('.m4v')).toBe(true);
  });
});

describe('isVfrSuspect', () => {
  it('is false when there is no nominal rate to compare against', () => {
    expect(isVfrSuspect(29.97)).toBe(false);
  });
  it('is false when avg and nominal agree', () => {
    expect(isVfrSuspect(30, 30)).toBe(false);
  });
  it('is true when avg and nominal diverge meaningfully', () => {
    expect(isVfrSuspect(24.3, 30)).toBe(true);
  });
});

describe('probeForPlan', () => {
  it('flags a non-H.264/HEVC codec', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      ffprobeJson({
        streams: [
          { codec_type: 'video', codec_name: 'prores', avg_frame_rate: '30/1', r_frame_rate: '30/1', width: 1920, height: 1080, duration: '10' },
          { codec_type: 'audio' },
        ],
      }),
    );
    const root = tmpDir('vedit-batch-plan-');
    const f = path.join(root, 'a.mov');
    await fs.writeFile(f, 'x'.repeat(100));
    const entry = await probeForPlan(f);
    expect(entry.warnings.map((w) => w.code)).toEqual(['codec']);
    expect(entry.size).toBe(100);
  });

  it('flags VFR-suspect footage when avg/nominal frame rates disagree', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      ffprobeJson({
        streams: [
          { codec_type: 'video', codec_name: 'h264', avg_frame_rate: '24000/1000', r_frame_rate: '30/1', width: 1920, height: 1080, duration: '10' },
          { codec_type: 'audio' },
        ],
      }),
    );
    const root = tmpDir('vedit-batch-plan-');
    const f = path.join(root, 'a.mp4');
    await fs.writeFile(f, 'x');
    const entry = await probeForPlan(f);
    expect(entry.warnings.map((w) => w.code)).toEqual(['vfr']);
  });

  it('flags no-audio', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(ffprobeJson({ streams: [{ codec_type: 'video', codec_name: 'h264', avg_frame_rate: '30/1', r_frame_rate: '30/1', width: 1920, height: 1080, duration: '10' }] })); // no audio stream
    const root = tmpDir('vedit-batch-plan-');
    const f = path.join(root, 'a.mp4');
    await fs.writeFile(f, 'x');
    const entry = await probeForPlan(f);
    expect(entry.warnings.map((w) => w.code)).toEqual(['no-audio']);
  });

  it('flags Log/HLG color via needsColorTransform', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(
      ffprobeJson({
        streams: [
          { codec_type: 'video', codec_name: 'h264', avg_frame_rate: '30/1', r_frame_rate: '30/1', width: 1920, height: 1080, duration: '10', color_transfer: 'arib-std-b67', color_primaries: 'bt2020' },
          { codec_type: 'audio' },
        ],
      }),
    );
    const root = tmpDir('vedit-batch-plan-');
    const f = path.join(root, 'a.mp4');
    await fs.writeFile(f, 'x');
    const entry = await probeForPlan(f);
    expect(entry.warnings.map((w) => w.code)).toEqual(['color']);
  });

  it('produces no warnings for clean H.264 CFR footage with audio and no color tags', async () => {
    runMock.mockReset();
    runMock.mockResolvedValue(ffprobeJson());
    const root = tmpDir('vedit-batch-plan-');
    const f = path.join(root, 'a.mp4');
    await fs.writeFile(f, 'x');
    const entry = await probeForPlan(f);
    expect(entry.warnings).toEqual([]);
  });
});

describe('sortByCreationTime', () => {
  it('orders by format.tags.creation_time ascending, falling back to mtime when absent', async () => {
    const entries = [
      { file: '/b.mp4', size: 1, duration: 1, fps: 30, width: 1, height: 1, hasAudio: true, creationTime: '2024-01-02T00:00:00Z', warnings: [] },
      { file: '/a.mp4', size: 1, duration: 1, fps: 30, width: 1, height: 1, hasAudio: true, creationTime: '2024-01-01T00:00:00Z', warnings: [] },
    ];
    const sorted = await sortByCreationTime(entries as any);
    expect(sorted.map((e) => e.file)).toEqual(['/a.mp4', '/b.mp4']);
  });
});

describe('detectDuplicates', () => {
  it('flags a second file in the batch with the same hash, keeping the first', () => {
    const { unique, duplicates } = detectDuplicates(
      [
        { file: '/a.mp4', hash: 'h1' },
        { file: '/b.mp4', hash: 'h1' },
        { file: '/c.mp4', hash: 'h2' },
      ],
      new Map(),
    );
    expect(unique.map((u) => u.file)).toEqual(['/a.mp4', '/c.mp4']);
    expect(duplicates).toEqual([{ file: '/b.mp4', hash: 'h1', kind: 'batch', duplicateOf: '/a.mp4' }]);
  });

  it('flags a file matching an existing project source, preferring that over a batch-internal match', () => {
    const { unique, duplicates } = detectDuplicates(
      [
        { file: '/a.mp4', hash: 'h1' },
        { file: '/b.mp4', hash: 'h1' }, // same as a.mp4 AND same as existing source src1
      ],
      new Map([['h1', 'src1']]),
    );
    expect(unique).toEqual([]);
    expect(duplicates).toEqual([
      { file: '/a.mp4', hash: 'h1', kind: 'existing', duplicateOf: 'src1' },
      { file: '/b.mp4', hash: 'h1', kind: 'existing', duplicateOf: 'src1' },
    ]);
  });
});

describe('journal (read/write + resume)', () => {
  it('round-trips through readJournal/createJournal.record atomically', async () => {
    const dir = tmpDir('vedit-batch-journal-');
    expect(await readJournal(dir)).toEqual([]);
    const journal = createJournal(dir, []);
    await journal.record({ file: '/a.mp4', sha256: 'h1', status: 'planned', at: 't1' });
    await journal.record({ file: '/a.mp4', sha256: 'h1', status: 'ingested', at: 't2' });
    const onDisk = await readJournal(dir);
    expect(onDisk).toEqual([{ file: '/a.mp4', sha256: 'h1', status: 'ingested', at: 't2' }]);
  });

  it('serializes concurrent record() calls so no update is lost (regression: unlocked read-modify-write would drop one)', async () => {
    const dir = tmpDir('vedit-batch-journal-race-');
    const journal = createJournal(dir, []);
    const files = Array.from({ length: 10 }, (_, i) => `/file${i}.mp4`);
    await Promise.all(files.map((f) => journal.record({ file: f, status: 'ingested', at: 't' })));
    const onDisk = await readJournal(dir);
    expect(onDisk).toHaveLength(10);
    expect(new Set(onDisk.map((e) => e.file))).toEqual(new Set(files));
  });

  it('a prior "ingested" entry lets a resumed run identify files to skip', async () => {
    const dir = tmpDir('vedit-batch-journal-resume-');
    const journal = createJournal(dir, []);
    await journal.record({ file: '/a.mp4', status: 'ingested', at: 't1' });
    await journal.record({ file: '/b.mp4', status: 'failed', error: 'boom', at: 't2' });
    const reread: IngestJournalEntry[] = await readJournal(dir);
    const ingested = new Set(reread.filter((e) => e.status === 'ingested').map((e) => e.file));
    expect(ingested.has('/a.mp4')).toBe(true);
    expect(ingested.has('/b.mp4')).toBe(false); // failed entries are NOT skipped — they're retried
  });

  it('journalPath is <project>/ingest-journal.json', () => {
    expect(journalPath('/proj')).toBe(path.join('/proj', 'ingest-journal.json'));
  });
});

describe('copy mode', () => {
  it('copyPlain copies into destDir, disambiguating a name collision', async () => {
    const srcDir = tmpDir('vedit-batch-copysrc-');
    const destDir = path.join(tmpDir('vedit-batch-copydest-'), 'dest');
    const src1 = path.join(srcDir, 'clip.mp4');
    await fs.writeFile(src1, 'one');
    const dest1 = await copyPlain(src1, destDir);
    expect(path.basename(dest1)).toBe('clip.mp4');
    expect(await fs.readFile(dest1, 'utf8')).toBe('one');

    // A second, different source file with the same basename must not clobber the first copy.
    const srcDir2 = tmpDir('vedit-batch-copysrc2-');
    const src2 = path.join(srcDir2, 'clip.mp4');
    await fs.writeFile(src2, 'two');
    const dest2 = await copyPlain(src2, destDir);
    expect(dest2).not.toBe(dest1);
    expect(await fs.readFile(dest1, 'utf8')).toBe('one'); // untouched
    expect(await fs.readFile(dest2, 'utf8')).toBe('two');
  });

  it('copyAndVerify succeeds and returns the dest path when the copy matches the expected hash', async () => {
    const srcDir = tmpDir('vedit-batch-verify-ok-src-');
    const destDir = path.join(tmpDir('vedit-batch-verify-ok-dest-'), 'dest');
    const src = path.join(srcDir, 'clip.mp4');
    await fs.writeFile(src, 'payload');
    const expected = await sha256File(src);
    const dest = await copyAndVerify(src, destDir, expected);
    expect(await fs.readFile(dest, 'utf8')).toBe('payload');
  });

  it('copyAndVerify throws and removes the bad copy when the expected hash does not match (simulated corruption)', async () => {
    const srcDir = tmpDir('vedit-batch-verify-bad-src-');
    const destDir = path.join(tmpDir('vedit-batch-verify-bad-dest-'), 'dest');
    const src = path.join(srcDir, 'clip.mp4');
    await fs.writeFile(src, 'payload');
    await expect(copyAndVerify(src, destDir, 'deadbeef'.repeat(8))).rejects.toThrow(/verification failed/);
    // no leftover file at the natural dest path
    await expect(fs.access(path.join(destDir, 'clip.mp4'))).rejects.toThrow();
  });
});

describe('runPool', () => {
  it('runs all items with no more than `concurrency` in flight at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    await runPool(items, 2, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('processes every item exactly once', async () => {
    const seen: number[] = [];
    await runPool([1, 2, 3, 4, 5], 3, async (item) => {
      seen.push(item);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });
});
