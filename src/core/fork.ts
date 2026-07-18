import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Project } from './project.js';
import type { Manifest } from './types.js';

/**
 * `vedit fork --project <src> --to <dir> [--name <名前>]` (roadmap "W6 派生
 * プロジェクトフォーク"). Addresses the pain verification scenario 2 hit
 * directly: deriving a vertical short from a horizontal project used to mean
 * re-ingesting the source footage into a fresh project (re-generating
 * proxy/waveform/scenes/transcript from scratch) just to get an independent
 * editing branch. Forking instead:
 *
 * (a) snapshots the CURRENT manifest as the new project's revision-0 state —
 *     same "freshly created project, but pre-populated" shape as
 *     Project.create(), so `vedit open`/every op works immediately, and the
 *     fork's own revisions.jsonl starts EMPTY (no entries at all until the
 *     first edit lands, exactly like a brand-new project) — the fork's
 *     history is never mixed with the source project's;
 * (b) leaves every Source.path untouched (absolute, pointing at the ORIGINAL
 *     media) — a link-ingested source stays a link, sharing the same file on
 *     disk between both projects, matching every other manifest field that
 *     already treats Source.path as user-owned/never-copied;
 * (c) hardlinks (falling back to a plain copy across filesystems/on
 *     filesystems without hardlink support) every proxy/waveform/scene-
 *     thumbnail/transcript file the cloned manifest references, so the fork
 *     never has to regenerate them.
 *
 * Registers the new project in the cross-project registry (upsertProject,
 * via Project.create()) so it shows up in `vedit projects` like anything
 * else.
 */
export interface ForkResult {
  dir: string;
  name: string;
  sourceDir: string;
  /** The source project's revision this fork was taken from. */
  sourceRevision: number;
  linked: {
    proxies: number;
    peaks: number;
    sceneFiles: number;
    sceneThumbs: number;
    transcripts: number;
    motionSpecs: number;
  };
}

/** Hardlink `src` to `dest` (falls back to a plain copy on EXDEV/unsupported filesystems). Silently skipped when `src` doesn't exist — a not-yet-generated cache artifact isn't a fork failure, just nothing to carry over. */
async function linkOrCopy(src: string, dest: string): Promise<boolean> {
  try {
    await fs.access(src);
  } catch {
    return false;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.link(src, dest);
  } catch {
    await fs.copyFile(src, dest);
  }
  return true;
}

export async function forkProject(srcDir: string, destDir: string, opts: { name?: string } = {}): Promise<ForkResult> {
  const absSrc = path.resolve(srcDir);
  const absDest = path.resolve(destDir);
  if (absSrc === absDest) throw new Error('fork: --to must be a different directory from the source project');
  try {
    await fs.access(path.join(absDest, 'project.json'));
    throw new Error(`fork: ${absDest} already has a project (project.json exists) — choose an empty --to directory`);
  } catch (e: any) {
    if (e?.code !== 'ENOENT') throw e; // any other error (including our own thrown Error above) propagates
  }

  const src = await Project.open(absSrc);
  const srcManifest = await src.manifest();
  const name = opts.name ?? `${srcManifest.name} (fork)`;

  // Project.create() does the directory/registry boilerplate (mkdir cache/
  // + motion/, write an empty starter manifest, upsertProject) — then we
  // overwrite its manifest with the real cloned snapshot. Bypasses commit()
  // deliberately: this is project CREATION, not a running project's edit,
  // so there's no baseRev to check against and no revisions.jsonl entry to
  // write (a fork's log starts genuinely empty, see this module's doc).
  const dest = await Project.create(absDest, name);
  const cloned: Manifest = { ...(JSON.parse(JSON.stringify(srcManifest)) as Manifest), name, revision: 0 };
  const tmp = `${dest.manifestPath}.tmp-fork-${Math.random().toString(36).slice(2)}`;
  await fs.writeFile(tmp, JSON.stringify(cloned, null, 2));
  await fs.rename(tmp, dest.manifestPath);

  const linked = { proxies: 0, peaks: 0, sceneFiles: 0, sceneThumbs: 0, transcripts: 0, motionSpecs: 0 };

  for (const s of cloned.sources) {
    if (s.proxy) {
      if (await linkOrCopy(path.join(absSrc, s.proxy), path.join(absDest, s.proxy))) linked.proxies++;
    }
    if (s.peaks) {
      if (await linkOrCopy(path.join(absSrc, s.peaks), path.join(absDest, s.peaks))) linked.peaks++;
    }
    if (s.transcribed) {
      if (await linkOrCopy(src.transcriptPath(s.id), dest.transcriptPath(s.id))) linked.transcripts++;
    }
    // Scene index (scenes-<sourceId>.json) + every thumbnail it references
    // (cache/sc-<sourceId>-<sceneId>.jpg) — read from the SOURCE project
    // directly (not `dest.scenes()`, which would read the not-yet-copied
    // file and always return empty) since Project.scenes() degrades to
    // `{sourceId, scenes: []}` when the file doesn't exist rather than
    // throwing.
    const sceneFile = await src.scenes(s.id);
    if (sceneFile.scenes.length > 0) {
      if (await linkOrCopy(src.scenesPath(s.id), dest.scenesPath(s.id))) linked.sceneFiles++;
      for (const scene of sceneFile.scenes) {
        if (scene.thumb && (await linkOrCopy(path.join(absSrc, scene.thumb), path.join(absDest, scene.thumb)))) {
          linked.sceneThumbs++;
        }
      }
    }
  }

  // Motion sidecars (motion/<id>.json) — every MotionItem in the cloned
  // timeline needs its spec file to actually render/preview correctly.
  for (const item of cloned.timeline.motion) {
    if (await linkOrCopy(src.motionSpecPath(item.id), dest.motionSpecPath(item.id))) linked.motionSpecs++;
  }

  return { dir: absDest, name, sourceDir: absSrc, sourceRevision: srcManifest.revision, linked };
}
