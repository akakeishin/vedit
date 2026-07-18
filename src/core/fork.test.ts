import { describe, expect, it, vi } from 'vitest';
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

async function tamperManifest(p: Project, mutate: (manifest: Manifest) => Manifest): Promise<void> {
  const current = JSON.parse(await fsp.readFile(p.manifestPath, 'utf8')) as Manifest;
  await fsp.writeFile(p.manifestPath, JSON.stringify(mutate(current), null, 2));
}

async function expectAbsent(file: string): Promise<void> {
  await expect(fsp.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function expectNoForkScratch(root: string): Promise<void> {
  const names = await fsp.readdir(root);
  expect(names.filter((name) => name.includes('.vedit-fork-stage-'))).toEqual([]);
  expect(names.filter((name) => /^\.vedit-fork-.*\.lock$/.test(name))).toEqual([]);
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

  it('CoW-clones/copies every managed artifact onto an independent inode', async () => {
    const root = freshRoot('independent-copy');
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
      expect([destStat.dev, destStat.ino]).not.toEqual([srcStat.dev, srcStat.ino]);
      expect(await fsp.readFile(path.join(destDir, destRel)))
        .toEqual(await fsp.readFile(path.join(src.dir, srcRel)));
    }
  });

  it('source-project cache regeneration cannot change the already-published fork', async () => {
    const root = freshRoot('cache-regeneration');
    const src = await seededSourceProject(root);
    const destDir = path.join(root, 'dest');
    await forkProject(src.dir, destDir);

    const files = [
      'cache/proxy-s1.mp4',
      'cache/peaks-s1.json',
      'cache/sc-s1-sc1.jpg',
      'transcript-s1.json',
      'motion/mo1.json',
    ];
    const forkBefore = new Map<string, Buffer>();
    for (const rel of files) forkBefore.set(rel, await fsp.readFile(path.join(destDir, rel)));

    // These direct rewrites model the current cache generators (`ffmpeg -y`
    // and writeFile), which mutate the source pathname's inode in place.
    for (const rel of files) await fsp.writeFile(path.join(src.dir, rel), `regenerated:${rel}`);

    for (const rel of files) {
      expect(await fsp.readFile(path.join(destDir, rel))).toEqual(forkBefore.get(rel));
      const [sourceStat, forkStat] = await Promise.all([
        fsp.stat(path.join(src.dir, rel)),
        fsp.stat(path.join(destDir, rel)),
      ]);
      expect([forkStat.dev, forkStat.ino]).not.toEqual([sourceStat.dev, sourceStat.ino]);
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
    await expect(forkProject(src.dir, destDir)).rejects.toThrow(/destination already exists/);
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

  it('refuses every pre-existing destination kind without changing its contents', async () => {
    const root = freshRoot('existing-kinds');
    const src = await seededSourceProject(root);

    const emptyDir = path.join(root, 'empty-dest');
    await fsp.mkdir(emptyDir);
    await fsp.writeFile(path.join(emptyDir, 'keep.txt'), 'must-survive');
    await expect(forkProject(src.dir, emptyDir)).rejects.toThrow(/destination already exists/);
    expect(await fsp.readFile(path.join(emptyDir, 'keep.txt'), 'utf8')).toBe('must-survive');

    const fileDest = path.join(root, 'file-dest');
    await fsp.writeFile(fileDest, 'must-survive');
    await expect(forkProject(src.dir, fileDest)).rejects.toThrow(/destination already exists/);
    expect(await fsp.readFile(fileDest, 'utf8')).toBe('must-survive');

    const symlinkTarget = path.join(root, 'symlink-target');
    const symlinkDest = path.join(root, 'symlink-dest');
    await fsp.mkdir(symlinkTarget);
    await fsp.symlink(symlinkTarget, symlinkDest);
    await expect(forkProject(src.dir, symlinkDest)).rejects.toThrow(/destination already exists/);
    expect((await fsp.lstat(symlinkDest)).isSymbolicLink()).toBe(true);
    expect(await fsp.readdir(symlinkTarget)).toEqual([]);
  });

  it('refuses filesystem roots and a destination nested inside the source project', async () => {
    const root = freshRoot('unsafe-destination');
    const src = await seededSourceProject(root);
    await expect(forkProject(src.dir, path.parse(root).root)).rejects.toThrow(/filesystem root/);
    const nested = path.join(src.dir, 'fork-inside-source');
    await expect(forkProject(src.dir, nested)).rejects.toThrow(/must not contain one another/);
    await expectAbsent(nested);
    const deeplyNested = path.join(src.dir, 'must-not-create', 'nested-fork');
    await expect(forkProject(src.dir, deeplyNested)).rejects.toThrow(/must not contain one another/);
    await expectAbsent(path.join(src.dir, 'must-not-create'));
  });

  it('rejects a manifest-managed path outside cache before creating the destination', async () => {
    const root = freshRoot('tampered-managed-path');
    const src = await seededSourceProject(root);
    await tamperManifest(src, (manifest) => ({
      ...manifest,
      sources: manifest.sources.map((source) => ({ ...source, proxy: 'project.json' })),
    }));
    const dest = path.join(root, 'dest');
    await expect(forkProject(src.dir, dest)).rejects.toThrow(/must be a file below cache/);
    await expectAbsent(dest);
    await expectNoForkScratch(root);
  });

  it('rejects a missing cache child whose existing ancestor symlink escapes the project', async () => {
    const root = freshRoot('tampered-symlink-ancestor');
    const src = await seededSourceProject(root);
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    await fsp.symlink(outside, path.join(src.cacheDir, 'escape'));
    await tamperManifest(src, (manifest) => ({
      ...manifest,
      sources: manifest.sources.map((source) => ({ ...source, proxy: 'cache/escape/not-created.mp4' })),
    }));
    const dest = path.join(root, 'dest');
    await expect(forkProject(src.dir, dest)).rejects.toThrow(/escapes directory \(symlink\)/);
    await expectAbsent(dest);
    await expectAbsent(path.join(outside, 'not-created.mp4'));
    await expectNoForkScratch(root);
  });

  it('rejects path-bearing ids and motion spec paths from a tampered manifest', async () => {
    const idRoot = freshRoot('tampered-id');
    const idSrc = await seededSourceProject(idRoot);
    await tamperManifest(idSrc, (manifest) => ({
      ...manifest,
      sources: manifest.sources.map((source) => ({ ...source, id: '../../escape' })),
    }));
    await expect(forkProject(idSrc.dir, path.join(idRoot, 'dest'))).rejects.toThrow(/invalid source id/);
    await expectAbsent(path.join(idRoot, 'dest'));

    const specRoot = freshRoot('tampered-motion-spec');
    const specSrc = await seededSourceProject(specRoot);
    await tamperManifest(specSrc, (manifest) => ({
      ...manifest,
      timeline: {
        ...manifest.timeline,
        motion: manifest.timeline.motion.map((item) => ({ ...item, spec: '../../project.json' })),
      },
    }));
    await expect(forkProject(specSrc.dir, path.join(specRoot, 'dest'))).rejects.toThrow(/invalid spec path/);
    await expectAbsent(path.join(specRoot, 'dest'));
  });

  it('rejects an escaping thumbnail path from a tampered scene index', async () => {
    const root = freshRoot('tampered-scene-thumb');
    const src = await seededSourceProject(root);
    const outside = path.join(root, 'outside');
    await fsp.mkdir(outside);
    await fsp.symlink(outside, path.join(src.cacheDir, 'escape'));
    const scenes = await src.scenes('s1');
    scenes.scenes[0].thumb = 'cache/escape/not-created.jpg';
    await fsp.writeFile(src.scenesPath('s1'), JSON.stringify(scenes));
    const dest = path.join(root, 'dest');
    await expect(forkProject(src.dir, dest)).rejects.toThrow(/escapes directory \(symlink\)/);
    await expectAbsent(dest);
    await expectNoForkScratch(root);
  });

  it('fails closed when a referenced cache artifact is missing', async () => {
    const root = freshRoot('missing-reference');
    const src = await seededSourceProject(root);
    await fsp.rm(path.join(src.cacheDir, 'proxy-s1.mp4'));
    const dest = path.join(root, 'dest');
    await expect(forkProject(src.dir, dest)).rejects.toThrow(/referenced proxy.*is missing/);
    await expectAbsent(dest);
    await expectNoForkScratch(root);
  });

  it('rolls back a partially assembled stage when artifact cloning fails', async () => {
    const root = freshRoot('stage-rollback');
    const src = await seededSourceProject(root);
    const dest = path.join(root, 'dest');
    const realCopy = fsp.copyFile.bind(fsp);
    const copySpy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      if (String(from).endsWith('peaks-s1.json')) {
        throw Object.assign(new Error('simulated disk I/O failure'), { code: 'EIO' });
      }
      return realCopy(from, to, mode);
    });
    try {
      await expect(forkProject(src.dir, dest)).rejects.toThrow(/simulated disk I\/O failure/);
    } finally {
      copySpy.mockRestore();
    }
    await expectAbsent(dest);
    await expectNoForkScratch(root);
    const registry = await listProjects();
    expect(registry.some((entry) => path.resolve(entry.dir) === path.resolve(dest))).toBe(false);
    expect(registry.some((entry) => entry.dir.includes('.vedit-fork-stage-'))).toBe(false);
  });

  it('rejects and rolls back a cache file that changes during clone/copy', async () => {
    const root = freshRoot('source-cache-race');
    const src = await seededSourceProject(root);
    const dest = path.join(root, 'dest');
    const realCopy = fsp.copyFile.bind(fsp);
    const copySpy = vi.spyOn(fsp, 'copyFile').mockImplementation(async (from, to, mode) => {
      await realCopy(from, to, mode);
      if (String(from).endsWith('proxy-s1.mp4')) {
        await fsp.writeFile(String(from), 'changed-during-copy');
      }
    });
    try {
      await expect(forkProject(src.dir, dest)).rejects.toThrow(/changed while it was being copied/);
    } finally {
      copySpy.mockRestore();
    }
    await expectAbsent(dest);
    await expectNoForkScratch(root);
  });

  it('does not overwrite a destination that appears at the publication boundary', async () => {
    const root = freshRoot('publish-race');
    const src = await seededSourceProject(root);
    const dest = path.join(root, 'dest');
    const realRename = fsp.rename.bind(fsp);
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(from).includes('.vedit-fork-stage-') && path.basename(String(to)) === 'dest') {
        await fsp.mkdir(String(to));
        await fsp.writeFile(path.join(String(to), 'external.txt'), 'must-survive');
        throw Object.assign(new Error('simulated destination race'), { code: 'EEXIST' });
      }
      return realRename(from, to);
    });
    try {
      await expect(forkProject(src.dir, dest)).rejects.toThrow(/simulated destination race/);
    } finally {
      renameSpy.mockRestore();
    }
    expect(await fsp.readFile(path.join(dest, 'external.txt'), 'utf8')).toBe('must-survive');
    await expectAbsent(path.join(dest, 'project.json'));
    await expectNoForkScratch(root);
  });

  it('serializes concurrent forks to the same destination and publishes exactly one complete project', async () => {
    const root = freshRoot('concurrent-publish');
    const src = await seededSourceProject(root);
    const dest = path.join(root, 'dest');
    const settled = await Promise.allSettled([
      forkProject(src.dir, dest, { name: 'winner' }),
      forkProject(src.dir, dest, { name: 'winner' }),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const manifest = await (await Project.open(dest)).manifest();
    expect(manifest.name).toBe('winner');
    expect(manifest.revision).toBe(0);
    expect(manifest.sources).toHaveLength(1);
    await expectNoForkScratch(root);
  });
});
