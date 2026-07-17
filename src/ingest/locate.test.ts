import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  fingerprintFile,
  fingerprintRanges,
  fingerprintsMatch,
  locateMedia,
  mdfindByName,
  type MediaFingerprint,
} from './locate.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), 'vedit-locate-'));
}

describe('fingerprintRanges', () => {
  it('covers the first and last 1MB for a large file', () => {
    const size = 10 * 1024 * 1024;
    const r = fingerprintRanges(size);
    expect(r).toEqual({ headStart: 0, headLen: 1024 * 1024, tailStart: size - 1024 * 1024, tailLen: 1024 * 1024 });
  });

  it('clamps to the whole file when smaller than the chunk size (head/tail overlap fully)', () => {
    const size = 500;
    const r = fingerprintRanges(size);
    expect(r).toEqual({ headStart: 0, headLen: 500, tailStart: 0, tailLen: 500 });
  });

  it('handles a zero-byte file without negative ranges', () => {
    const r = fingerprintRanges(0);
    expect(r).toEqual({ headStart: 0, headLen: 0, tailStart: 0, tailLen: 0 });
  });
});

describe('fingerprintFile', () => {
  it('returns null when the on-disk size does not match (the cheap pre-filter)', async () => {
    const dir = tmp();
    const file = path.join(dir, 'a.mp4');
    await fs.writeFile(file, Buffer.alloc(100, 1));
    expect(await fingerprintFile(file, 999)).toBeNull();
  });

  it('returns null for a missing file', async () => {
    expect(await fingerprintFile('/no/such/file/at/all.mp4', 100)).toBeNull();
  });

  it('computes matching head/tail sha256 for two files with identical content', async () => {
    const dir = tmp();
    const content = Buffer.concat([Buffer.alloc(1024 * 1024, 7), Buffer.alloc(1024 * 1024, 9)]);
    const fileA = path.join(dir, 'a.mp4');
    const fileB = path.join(dir, 'b.mp4');
    await fs.writeFile(fileA, content);
    await fs.writeFile(fileB, content);
    const fpA = await fingerprintFile(fileA, content.length);
    const fpB = await fingerprintFile(fileB, content.length);
    expect(fpA).not.toBeNull();
    expect(fpB).not.toBeNull();
    expect(fingerprintsMatch(fpA!, fpB!)).toBe(true);
    expect(fpA!.headSha256).toBe(sha256(content.subarray(0, 1024 * 1024)));
    expect(fpA!.tailSha256).toBe(sha256(content.subarray(content.length - 1024 * 1024)));
  });

  it('detects a mismatch when tail bytes differ but size and head match', async () => {
    const dir = tmp();
    const head = Buffer.alloc(1024 * 1024, 3);
    const fileA = path.join(dir, 'a.mp4');
    const fileB = path.join(dir, 'b.mp4');
    await fs.writeFile(fileA, Buffer.concat([head, Buffer.alloc(1024 * 1024, 1)]));
    await fs.writeFile(fileB, Buffer.concat([head, Buffer.alloc(1024 * 1024, 2)]));
    const fpA = await fingerprintFile(fileA, 2 * 1024 * 1024);
    const fpB = await fingerprintFile(fileB, 2 * 1024 * 1024);
    expect(fingerprintsMatch(fpA!, fpB!)).toBe(false);
  });
});

describe('mdfindByName', () => {
  it('parses newline-separated stdout into a path list', async () => {
    const fake: any = (_bin: string, _args: string[], _opts: any, cb: (err: any, stdout: string) => void) => {
      cb(null, '/Volumes/Cards/clip1.mp4\n/Users/x/clip1.mp4\n');
    };
    const out = await mdfindByName('clip1.mp4', fake);
    expect(out).toEqual(['/Volumes/Cards/clip1.mp4', '/Users/x/clip1.mp4']);
  });

  it('resolves to an empty list instead of throwing when mdfind errors (e.g. unavailable)', async () => {
    const fake: any = (_bin: string, _args: string[], _opts: any, cb: (err: any, stdout: string) => void) => {
      cb(new Error('spawn mdfind ENOENT'), '');
    };
    expect(await mdfindByName('clip1.mp4', fake)).toEqual([]);
  });

  it('passes the name as a single argv element (never shell-interpolated) even with quotes inside it', async () => {
    let capturedArgs: string[] = [];
    const fake: any = (_bin: string, args: string[], _opts: any, cb: (err: any, stdout: string) => void) => {
      capturedArgs = args;
      cb(null, '');
    };
    await mdfindByName('weird"name.mp4', fake);
    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]).toContain('weird\\"name.mp4');
  });
});

describe('locateMedia', () => {
  it('returns the first candidate whose size AND fingerprint both match', async () => {
    const dir = tmp();
    const content = Buffer.from('hello world, this is the real footage'.repeat(100));
    const good = path.join(dir, 'good.mp4');
    const bad = path.join(dir, 'bad.mp4');
    await fs.writeFile(good, content);
    await fs.writeFile(bad, Buffer.from('totally different content, same length!'.repeat(100 * Math.ceil(content.length / 40))).subarray(0, content.length));

    const target: MediaFingerprint = {
      size: content.length,
      headSha256: sha256(content.subarray(0, Math.min(1024 * 1024, content.length))),
      tailSha256: sha256(content.subarray(Math.max(0, content.length - 1024 * 1024))),
    };
    const mdfindStub = vi.fn().mockResolvedValue([bad, good]);
    const found = await locateMedia('clip.mp4', target, { mdfind: mdfindStub });
    expect(found).toBe(good);
    expect(mdfindStub).toHaveBeenCalledWith('clip.mp4');
  });

  it('returns null when no candidate matches', async () => {
    const dir = tmp();
    const file = path.join(dir, 'wrong.mp4');
    await fs.writeFile(file, Buffer.alloc(10, 1));
    const target: MediaFingerprint = { size: 999999, headSha256: 'x', tailSha256: 'y' };
    const found = await locateMedia('clip.mp4', target, { mdfind: async () => [file] });
    expect(found).toBeNull();
  });

  it('returns null (never throws) when mdfind itself yields nothing', async () => {
    const target: MediaFingerprint = { size: 1, headSha256: 'x', tailSha256: 'y' };
    const found = await locateMedia('clip.mp4', target, { mdfind: async () => [] });
    expect(found).toBeNull();
  });
});
