import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendExportResult, readExportResults, type ExportResultRecord } from './exportResults.js';

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vedit-exportresults-'));
}

function rec(overrides: Partial<ExportResultRecord> = {}): ExportResultRecord {
  return {
    ts: new Date().toISOString(),
    kind: 'render',
    file: '/tmp/out.mp4',
    ok: true,
    revision: 3,
    ...overrides,
  };
}

describe('exportResults: readExportResults on a missing/malformed cache file', () => {
  it('returns [] when cache/export-results.json does not exist (and cache/ itself does not exist)', async () => {
    const dir = freshDir();
    expect(await readExportResults(dir)).toEqual([]);
  });

  it('returns [] when the file contains invalid JSON', async () => {
    const dir = freshDir();
    await fsp.mkdir(path.join(dir, 'cache'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'cache', 'export-results.json'), '{not valid json');
    expect(await readExportResults(dir)).toEqual([]);
  });

  it('returns [] when the top-level JSON value is not an array', async () => {
    const dir = freshDir();
    await fsp.mkdir(path.join(dir, 'cache'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'cache', 'export-results.json'), JSON.stringify({ oops: true }));
    expect(await readExportResults(dir)).toEqual([]);
  });

  it('silently drops array elements that do not look like a record, keeping the well-formed ones', async () => {
    const dir = freshDir();
    await fsp.mkdir(path.join(dir, 'cache'), { recursive: true });
    const good = rec({ file: 'good.mp4' });
    await fsp.writeFile(
      path.join(dir, 'cache', 'export-results.json'),
      JSON.stringify([good, { garbage: 1 }, null, 'nope', 42]),
    );
    const results = await readExportResults(dir);
    expect(results).toEqual([good]);
  });
});

describe('exportResults: appendExportResult / readExportResults round trip', () => {
  it('creates cache/ and writes a single record readable back verbatim', async () => {
    const dir = freshDir();
    const r = rec({ kind: 'otio', file: 'out.otio', ok: true, revision: 1, warnings: ['a warning'] });
    await appendExportResult(dir, r);
    const results = await readExportResults(dir);
    expect(results).toEqual([r]);
  });

  it('prepends new records so the most recent append is first', async () => {
    const dir = freshDir();
    const r1 = rec({ file: 'first.mp4', revision: 1 });
    const r2 = rec({ file: 'second.mp4', revision: 2 });
    const r3 = rec({ file: 'third.mp4', revision: 3 });
    await appendExportResult(dir, r1);
    await appendExportResult(dir, r2);
    await appendExportResult(dir, r3);
    const results = await readExportResults(dir);
    expect(results.map((r) => r.file)).toEqual(['third.mp4', 'second.mp4', 'first.mp4']);
  });

  it('records a failed export with ok=false and an error message', async () => {
    const dir = freshDir();
    const r = rec({ kind: 'render', file: 'out.mp4', ok: false, error: 'ffmpeg exited with code 1' });
    await appendExportResult(dir, r);
    const results = await readExportResults(dir);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBe('ffmpeg exited with code 1');
  });

  it('truncates to the most recent 20 records once more than 20 have been appended', async () => {
    const dir = freshDir();
    for (let i = 0; i < 25; i++) {
      await appendExportResult(dir, rec({ file: `out-${i}.mp4`, revision: i }));
    }
    const results = await readExportResults(dir);
    expect(results).toHaveLength(20);
    // Newest (i=24) first, oldest kept is i=5 (the first 5 got dropped).
    expect(results[0].file).toBe('out-24.mp4');
    expect(results[19].file).toBe('out-5.mp4');
  });

  it('leaves no stray .tmp file behind after a successful append', async () => {
    const dir = freshDir();
    await appendExportResult(dir, rec());
    const entries = await fsp.readdir(path.join(dir, 'cache'));
    expect(entries).toEqual(['export-results.json']);
  });

  it('recovers from a corrupted existing file: appending after corruption starts a fresh, valid array', async () => {
    const dir = freshDir();
    await fsp.mkdir(path.join(dir, 'cache'), { recursive: true });
    await fsp.writeFile(path.join(dir, 'cache', 'export-results.json'), 'not json at all');
    const r = rec({ file: 'recovered.mp4' });
    await appendExportResult(dir, r);
    const results = await readExportResults(dir);
    expect(results).toEqual([r]);
  });
});
