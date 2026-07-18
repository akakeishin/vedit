import { describe, expect, it } from 'vitest';
import { mkdtempSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project } from './project.js';
import { listProjects } from './registry.js';
import { forkProject } from './fork.js';
import type { Manifest } from './types.js';

function freshRoot(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `vedit-fork-${prefix}-`));
}

/**
 * Builds a source project with a real source entry (proxy/peaks/transcribed)
 * plus the actual cache/scene/transcript files on disk that a real
 * ingest+detect+transcribe pipeline would have produced — everything
 * forkProject is supposed to carry over.
 */
async function seededSourceProject(root: string): Promise<Project> {
  const dir = path.join(root, 'src');
  const p = await Project.create(dir, 'source project');
  await fsp.mkdir(p.cacheDir, { recursive: true });
  await fsp.writeFile(path.join(p.dir, 'cache/proxy-s1.mp4'), 'proxy-bytes');
  await fsp.writeFile(path.join(p.dir, 'cache/peaks-s1.json'), '{"rate":10,"peaks":[0.1]}');
  await fsp.writeFile(path.join(p.dir, 'cache/sc-s1-sc1.jpg'), 'thumb-bytes');
  await fsp.writeFile(p.transcriptPath('s1'), JSON.stringify({ sourceId: 's1', language: 'ja', words: [] }));
  await p.writeScenes({
    sourceId: 's1',
    scenes: [{ id: 'sc1', t0: 0, t1: 1, thumb: 'cache/sc-s1-sc1.jpg', hasSpeech: false, energy: 0 }],
  });
  await fsp.writeFile(p.motionSpecPath('mo1'), JSON.stringify({ id: 'mo1', type: 'chapter-card', params: { text: 'hi' } }));

  await p.commit(0, 'claude', 'seed', {}, 'seed source + clip + motion', (m) => ({
    ...m,
    sources: [{
      id: 's1', path: '/media/original.mp4', duration: 60, fps: 30, width: 1920, height: 1080, hasAudio: true,
      proxy: 'cache/proxy-s1.mp4', peaks: 'cache/peaks-s1.json', transcribed: true,
    }],
    timeline: {
      ...m.timeline,
      video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }],
      motion: [{ id: 'mo1', spec: 'mo1.json', tlStart: 0, duration: 2 }],
    },
  }), { mo1: { id: 'mo1', type: 'chapter-card', params: { text: 'hi' } } });

  return p;
}

describe('forkProject', () => {
  it('snapshots the current manifest as the fork\'s revision-0 state, keeping Source.path untouched', async () => {
    const root = freshRoot('basic');
    const src = await seededSourceProject(root);
    const destDir = path.join(root, 'dest');

    const res = await forkProject(src.dir, destDir);
    expect(res.sourceRevision).toBe(1);
    expect(res.dir).toBe(path.resolve(destDir));

    const dest = await Project.open(destDir);
    const m = await dest.manifest();
    expect(m.revision).toBe(0);
    expect(m.name).toBe('source project (fork)');
    expect(m.sources).toHaveLength(1);
    expect(m.sources[0].path).toBe('/media/original.mp4'); // untouched — link-ingested source stays a link
    expect(m.timeline.video).toEqual([{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 60 }]);
  });

  it('honors an explicit --name', async () => {
    const root = freshRoot('name');
    const src = await seededSourceProject(root);
    const res = await forkProject(src.dir, path.join(root, 'dest'), { name: 'vertical cut' });
    expect(res.name).toBe('vertical cut');
    const m = await (await Project.open(res.dir)).manifest();
    expect(m.name).toBe('vertical cut');
  });

  it('hardlinks (same inode) proxy/peaks/scene-thumb/transcript/motion-spec files rather than regenerating them', async () => {
    const root = freshRoot('hardlink');
    const src = await seededSourceProject(root);
    const destDir = path.join(root, 'dest');
    const res = await forkProject(src.dir, destDir);
    expect(res.linked).toEqual({ proxies: 1, peaks: 1, sceneFiles: 1, sceneThumbs: 1, transcripts: 1, motionSpecs: 1 });

    const pairs: [string, string][] = [
      ['cache/proxy-s1.mp4', 'cache/proxy-s1.mp4'],
      ['cache/peaks-s1.json', 'cache/peaks-s1.json'],
      ['cache/sc-s1-sc1.jpg', 'cache/sc-s1-sc1.jpg'],
      ['transcript-s1.json', 'transcript-s1.json'],
      ['motion/mo1.json', 'motion/mo1.json'],
    ];
    for (const [srcRel, destRel] of pairs) {
      const [srcStat, destStat] = await Promise.all([
        fsp.stat(path.join(src.dir, srcRel)),
        fsp.stat(path.join(destDir, destRel)),
      ]);
      // Same inode + device = a real hardlink (not a copy) — the whole
      // point of avoiding regeneration. If the test filesystem doesn't
      // support hardlinks, linkOrCopy falls back to a copy and this
      // assertion would legitimately fail there; every CI/dev filesystem
      // this project targets (macOS APFS/HFS+, Linux ext4) supports them.
      expect(destStat.ino).toBe(srcStat.ino);
      expect(destStat.dev).toBe(srcStat.dev);
    }
  });

  it('the fork\'s revisions.jsonl starts empty — history is never mixed with the source\'s', async () => {
    const root = freshRoot('revlog');
    const src = await seededSourceProject(root); // source is already at revision 1 with 1 log entry
    const destDir = path.join(root, 'dest');
    await forkProject(src.dir, destDir);

    const dest = await Project.open(destDir);
    expect(await dest.revisions()).toEqual([]);

    // Editing the fork must never touch the source's own log/revision.
    await dest.commit(0, 'claude', 'note', {}, 'fork-only edit', (m) => ({ ...m, name: 'edited' }));
    expect((await dest.revisions()).map((r) => r.rev)).toEqual([1]);
    expect((await src.manifest()).revision).toBe(1); // source untouched
    expect((await src.revisions()).map((r) => r.rev)).toEqual([1]); // source's own log untouched
  });

  it('registers the new project in the cross-project registry', async () => {
    const root = freshRoot('registry');
    const src = await seededSourceProject(root);
    const destDir = path.join(root, 'dest');
    await forkProject(src.dir, destDir);

    const entries = await listProjects();
    expect(entries.some((e) => path.resolve(e.dir) === path.resolve(destDir))).toBe(true);
  });

  it('refuses to fork into a directory that already has a project.json', async () => {
    const root = freshRoot('collide');
    const src = await seededSourceProject(root);
    const destDir = path.join(root, 'dest');
    await Project.create(destDir, 'already here');
    await expect(forkProject(src.dir, destDir)).rejects.toThrow(/already has a project/);
  });

  it('refuses --to pointing at the same directory as the source', async () => {
    const root = freshRoot('same-dir');
    const src = await seededSourceProject(root);
    await expect(forkProject(src.dir, src.dir)).rejects.toThrow(/different directory/);
  });

  it('skips (not throws) a source whose proxy/peaks/transcript were never generated', async () => {
    const root = freshRoot('no-cache');
    const dir = path.join(root, 'src');
    const p = await Project.create(dir, 'bare');
    await p.commit(0, 'claude', 'seed', {}, 'seed', (m: Manifest) => ({
      ...m,
      sources: [{ id: 's1', path: '/x.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    }));
    const res = await forkProject(dir, path.join(root, 'dest'));
    expect(res.linked).toEqual({ proxies: 0, peaks: 0, sceneFiles: 0, sceneThumbs: 0, transcripts: 0, motionSpecs: 0 });
    const m = await (await Project.open(res.dir)).manifest();
    expect(m.sources).toHaveLength(1); // manifest content still carried over
  });
});
