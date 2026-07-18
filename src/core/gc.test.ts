import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project } from './project.js';
import { planGc, runGc } from './gc.js';

function freshDir(prefix: string): string {
  return path.join(mkdtempSync(path.join(tmpdir(), `vedit-gc-${prefix}-`)), 'proj');
}

/**
 * One live source (s1, proxy+peaks+scene+thumb all present and referenced),
 * plus a pile of cache/ files that should NOT survive a real gc: an orphan
 * proxy/peaks pair (as if source s1 had been re-ingested under a new id, or
 * s2 was removed from the timeline), an orphan scene thumbnail, a stray
 * unrecognized cache file (e.g. an old range-preview render), and the two
 * always-protected special files (fonts.json/export-results.json) which
 * must survive despite matching no manifest reference either.
 */
async function seeded(dir: string): Promise<Project> {
  const p = await Project.create(dir, 'gc-fixture');
  await fsp.mkdir(p.cacheDir, { recursive: true });

  // live: referenced by the manifest / scenes file below
  await fsp.writeFile(path.join(p.dir, 'cache/proxy-s1.mp4'), 'live-proxy');
  await fsp.writeFile(path.join(p.dir, 'cache/peaks-s1.json'), 'live-peaks');
  await fsp.writeFile(path.join(p.dir, 'cache/thumb-s1.jpg'), 'live-thumb'); // convention-named, no manifest field
  await fsp.writeFile(path.join(p.dir, 'cache/sc-s1-sc1.jpg'), 'live-scene-thumb');
  await fsp.writeFile(p.transcriptPath('s1'), '{"sourceId":"s1","language":"ja","words":[]}');

  // orphans
  await fsp.writeFile(path.join(p.dir, 'cache/proxy-s2.mp4'), 'orphan-proxy'); // s2 not in manifest
  await fsp.writeFile(path.join(p.dir, 'cache/peaks-s2.json'), 'orphan-peaks');
  await fsp.writeFile(path.join(p.dir, 'cache/sc-s1-sc9.jpg'), 'orphan-scene-thumb'); // not in scenes-s1.json
  await fsp.writeFile(path.join(p.dir, 'cache/range-preview-old.mp4'), 'orphan-preview'); // unrecognized convention
  await fsp.writeFile(p.transcriptPath('s2'), '{"sourceId":"s2","language":"ja","words":[]}'); // s2 fully removed

  // always-protected specials
  await fsp.writeFile(path.join(p.dir, 'cache/fonts.json'), '[]');
  await fsp.writeFile(path.join(p.dir, 'cache/export-results.json'), '[]');

  // in-flight write remnant — must never be touched at all
  await fsp.writeFile(path.join(p.dir, 'cache/project.json.tmp-abc123'), 'mid-write');

  await p.writeScenes({
    sourceId: 's1',
    scenes: [{ id: 'sc1', t0: 0, t1: 1, thumb: 'cache/sc-s1-sc1.jpg', hasSpeech: false, energy: 0 }],
  });
  await p.commit(0, 'claude', 'seed', {}, 'seed s1', (m) => ({
    ...m,
    sources: [{
      id: 's1', path: '/media/s1.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true,
      proxy: 'cache/proxy-s1.mp4', peaks: 'cache/peaks-s1.json', transcribed: true,
    }],
  }));
  return p;
}

describe('planGc', () => {
  it('lists exactly the expected orphans, protecting everything referenced (by field or convention) and the two special files', async () => {
    const p = await seeded(freshDir('plan'));
    const res = await planGc(p);
    const orphanPaths = res.orphans.map((o) => o.path).sort();
    expect(orphanPaths).toEqual([
      'cache/peaks-s2.json',
      'cache/proxy-s2.mp4',
      'cache/range-preview-old.mp4',
      'cache/sc-s1-sc9.jpg',
      'transcript-s2.json',
    ]);
    expect(res.totalBytes).toBe(res.orphans.reduce((a, o) => a + o.bytes, 0));
    expect(res.deleted).toBe(false);
  });

  it('never lists the in-flight tmp file', async () => {
    const p = await seeded(freshDir('tmp'));
    const res = await planGc(p);
    expect(res.orphans.some((o) => o.path.includes('.tmp-'))).toBe(false);
  });

  it('protects a live source\'s proxy/peaks/thumb/scene-thumb/transcript', async () => {
    const p = await seeded(freshDir('protect'));
    const res = await planGc(p);
    const orphanPaths = new Set(res.orphans.map((o) => o.path));
    for (const protectedPath of [
      'cache/proxy-s1.mp4', 'cache/peaks-s1.json', 'cache/thumb-s1.jpg', 'cache/sc-s1-sc1.jpg',
      'transcript-s1.json', 'cache/fonts.json', 'cache/export-results.json',
    ]) {
      expect(orphanPaths.has(protectedPath)).toBe(false);
    }
  });

  it('an empty/no cache dir plans cleanly with no orphans', async () => {
    const dir = freshDir('empty');
    const p = await Project.create(dir, 'empty');
    const res = await planGc(p);
    expect(res.orphans).toEqual([]);
    expect(res.totalBytes).toBe(0);
  });
});

describe('runGc', () => {
  it('defaults to dry-run: lists orphans but deletes nothing', async () => {
    const p = await seeded(freshDir('dryrun'));
    const res = await runGc(p);
    expect(res.deleted).toBe(false);
    expect(res.orphans.length).toBeGreaterThan(0);
    await expect(fsp.access(path.join(p.dir, 'cache/proxy-s2.mp4'))).resolves.toBeUndefined();
  });

  it('--yes actually deletes every listed orphan and nothing else', async () => {
    const p = await seeded(freshDir('yes'));
    const plan = await planGc(p);
    const res = await runGc(p, { yes: true });
    expect(res.deleted).toBe(true);
    expect(res.orphans).toEqual(plan.orphans);

    for (const o of res.orphans) {
      await expect(fsp.access(path.join(p.dir, o.path))).rejects.toThrow();
    }
    // Protected files survive.
    for (const survivor of [
      'cache/proxy-s1.mp4', 'cache/peaks-s1.json', 'cache/thumb-s1.jpg', 'cache/sc-s1-sc1.jpg',
      'transcript-s1.json', 'cache/fonts.json', 'cache/export-results.json', 'cache/project.json.tmp-abc123',
    ]) {
      await expect(fsp.access(path.join(p.dir, survivor))).resolves.toBeUndefined();
    }
    // revisions.jsonl itself (project root, not cache/) is never in scope.
    await expect(fsp.access(path.join(p.dir, 'revisions.jsonl'))).resolves.toBeUndefined();
  });
});
