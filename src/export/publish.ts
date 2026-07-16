import path from 'node:path';
import { promises as fs } from 'node:fs';
import { cropGeometry, keptWords, segments, sourceTimeToTimeline, timelineDuration } from '../core/ops.js';
import { captionCues } from '../core/captions.js';
import type { Manifest, SceneFile, Transcript } from '../core/types.js';
import type { Peaks } from '../core/detect.js';
import type { Project } from '../core/project.js';
import { run } from '../ingest/run.js';

/**
 * `vedit publish-pack` — read-only publish material generator (no --base,
 * never touches the manifest). Produces chapters.txt, thumbnails/, and
 * materials.json under a given outdir. Deliberately does NOT draft a title
 * or description: per the skill's citation rule (see editorial-playbook.md),
 * model-authored copy is a proposal made in conversation, never auto-written
 * to disk — materials.json exists so the director has what it needs to draft
 * with the user.
 */

// ---- chapters: pure derivation + formatting ----

export interface ChapterEntry {
  /** Timeline-domain seconds. */
  tlTime: number;
  title: string;
}

/** "0:00" / "1:23" / "1:02:03" — YouTube's chapter timestamp format. */
export function formatChapterTimestamp(t: number): string {
  const total = Math.max(0, Math.round(t));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Chapter entries sourced from chapter-card motion overlays (highest-priority source), sorted ascending. */
export function chaptersFromMotion(items: { tlStart: number; type: string; text?: string }[]): ChapterEntry[] {
  return items
    .filter((it) => it.type === 'chapter-card' && it.text && it.text.trim().length > 0)
    .map((it) => ({ tlTime: it.tlStart, title: it.text!.trim() }))
    .sort((a, b) => a.tlTime - b.tlTime);
}

/**
 * Chapter entries sourced from annotated scenes (fallback when there are no
 * chapter-card motion overlays): only scenes carrying a note become
 * chapters. Scene t0 is in SOURCE time; boundaries cut away by editing map
 * to null via sourceTimeToTimeline and are skipped.
 */
export function chaptersFromScenes(m: Manifest, sceneFile: SceneFile): ChapterEntry[] {
  const out: ChapterEntry[] = [];
  for (const sc of sceneFile.scenes) {
    if (!sc.note) continue;
    const tl = sourceTimeToTimeline(m, sceneFile.sourceId, sc.t0);
    if (tl === null) continue; // this boundary was cut away
    out.push({ tlTime: tl, title: sc.note.text });
  }
  return out.sort((a, b) => a.tlTime - b.tlTime);
}

export interface AssembledChapters {
  entries: ChapterEntry[];
  lines: string[];
}

/**
 * Sort, dedupe (entries within 0.5s of a kept one are dropped — usually
 * near-duplicate scene notes), and guarantee the list starts at 0:00
 * (synthesizing an "オープニング" chapter when the first real one isn't
 * already there). Returns a reason instead of an empty file when there is
 * nothing to chapter at all.
 */
export function assembleChapterLines(entries: ChapterEntry[]): AssembledChapters | { entries: null; lines: null; reason: string } {
  if (entries.length === 0) {
    return { entries: null, lines: null, reason: 'no chapter-card motion overlays and no annotated scenes with notes — nothing to base chapters on' };
  }
  const sorted = [...entries].sort((a, b) => a.tlTime - b.tlTime);
  const deduped: ChapterEntry[] = [];
  for (const e of sorted) {
    if (deduped.length > 0 && e.tlTime - deduped[deduped.length - 1].tlTime < 0.5) continue;
    deduped.push(e);
  }
  const withOpening = deduped[0].tlTime > 0.5 ? [{ tlTime: 0, title: 'オープニング' }, ...deduped] : deduped;
  const lines = withOpening.map((e) => `${formatChapterTimestamp(e.tlTime)} ${e.title}`);
  return { entries: withOpening, lines };
}

// ---- thumbnails: pure candidate selection ----

export interface ThumbPoint {
  tlTime: number;
  sourceId: string;
  srcTime: number;
  crop?: { x?: number; y?: number };
  reason: 'chapter' | 'energy';
}

/**
 * Pick up to `count` timeline moments to thumbnail: chapter starts first
 * (ascending), then the highest-energy waveform moments filling any
 * remaining budget — spaced apart so thumbnails don't cluster on one loud
 * beat. Peaks are keyed by sourceId (Source.peaks, already loaded by the
 * caller) and are looked up only within each segment's kept source range, so
 * a peak inside footage that got cut away is never a candidate. Pure: given
 * the same manifest + peaks, always returns the same points — actual JPG
 * extraction (ffmpeg) happens in publishPack.
 */
export function selectThumbnailPoints(
  m: Manifest,
  chapterTimes: number[],
  peaksBySource: Record<string, Peaks>,
  count: number,
): ThumbPoint[] {
  const segs = segments(m);
  if (segs.length === 0 || count <= 0) return [];
  const total = segs[segs.length - 1].tlEnd;

  const tlToPoint = (tl: number, reason: ThumbPoint['reason']): ThumbPoint | null => {
    const seg = segs.find((s) => tl >= s.tlStart && tl < s.tlEnd) ?? (tl >= total ? segs[segs.length - 1] : null);
    if (!seg) return null;
    const clampedTl = Math.min(Math.max(tl, seg.tlStart), seg.tlEnd - 1e-6);
    return { tlTime: clampedTl, sourceId: seg.sourceId, srcTime: seg.srcStart + (clampedTl - seg.tlStart), crop: seg.crop, reason };
  };

  const minGap = Math.max(0.5, total / Math.max(1, count * 4));
  const chosen: ThumbPoint[] = [];
  const tooClose = (tl: number) => chosen.some((c) => Math.abs(c.tlTime - tl) < minGap);

  for (const tl of [...chapterTimes].sort((a, b) => a - b)) {
    if (chosen.length >= count) break;
    if (tooClose(tl)) continue;
    const pt = tlToPoint(tl, 'chapter');
    if (pt) chosen.push(pt);
  }

  const remaining = count - chosen.length;
  if (remaining > 0) {
    const samples: { tlTime: number; energy: number }[] = [];
    for (const seg of segs) {
      const peaks = peaksBySource[seg.sourceId];
      if (!peaks || peaks.peaks.length === 0 || peaks.rate <= 0) continue;
      const segDur = seg.tlEnd - seg.tlStart;
      const i0 = Math.max(0, Math.floor(seg.srcStart * peaks.rate));
      const i1 = Math.min(peaks.peaks.length, Math.ceil((seg.srcStart + segDur) * peaks.rate));
      for (let i = i0; i < i1; i++) {
        const srcT = i / peaks.rate;
        samples.push({ tlTime: seg.tlStart + (srcT - seg.srcStart), energy: peaks.peaks[i] });
      }
    }
    samples.sort((a, b) => b.energy - a.energy);
    for (const s of samples) {
      if (chosen.length >= count) break;
      if (tooClose(s.tlTime)) continue;
      const pt = tlToPoint(s.tlTime, 'energy');
      if (pt) chosen.push(pt);
    }
  }

  return chosen.sort((a, b) => a.tlTime - b.tlTime);
}

// ---- materials.json ----

export interface PublishMaterials {
  duration: number;
  chapterList: string[];
  sources: { file: string; duration: number }[];
  keptWordCount: number;
  captionsCueCount: number;
}

/** Factual material for the director to draft a title/description from in conversation — never a generated description itself. */
export function buildMaterials(m: Manifest, transcripts: Transcript[], chapterLines: string[]): PublishMaterials {
  return {
    duration: timelineDuration(m),
    chapterList: chapterLines,
    sources: m.sources.map((s) => ({ file: path.basename(s.path), duration: s.duration })),
    keptWordCount: transcripts.reduce((a, t) => a + keptWords(m, t.sourceId, t.words).length, 0),
    captionsCueCount: captionCues(m, transcripts).length,
  };
}

// ---- orchestration (impure: fs + ffmpeg) ----

async function loadPeaksBySource(project: Project, m: Manifest): Promise<Record<string, Peaks>> {
  const out: Record<string, Peaks> = {};
  for (const s of m.sources) {
    if (!s.peaks) continue;
    try {
      out[s.id] = JSON.parse(await fs.readFile(path.join(project.dir, s.peaks), 'utf8'));
    } catch {
      // peaks flagged but file missing/corrupt; that source just contributes no energy candidates
    }
  }
  return out;
}

export interface PublishPackResult {
  outdir: string;
  files: string[];
  chaptersFile: string | null;
  chaptersReason?: string;
  thumbnails: string[];
  materialsFile: string;
}

/**
 * Full publish-pack pipeline: chapters (motion chapter-cards, else annotated
 * scenes) -> thumbnail candidate selection -> full-res JPG extraction from
 * ORIGINAL sources (never proxies, so publish-quality stills) -> materials.json.
 * Entirely read-only with respect to the project (no manifest mutation, no
 * --base needed).
 */
export async function publishPack(
  project: Project,
  m: Manifest,
  transcripts: Transcript[],
  outdir: string,
  opts: { thumbs?: number } = {},
): Promise<PublishPackResult> {
  const thumbsCount = opts.thumbs ?? 6;
  await fs.mkdir(outdir, { recursive: true });

  // ---- chapters ----
  const motionEntries: { tlStart: number; type: string; text?: string }[] = [];
  for (const item of m.timeline.motion) {
    try {
      const spec = (await project.readMotionSpec(item.id)) as { type: string; params?: Record<string, unknown> };
      const text = typeof spec.params?.text === 'string' ? (spec.params.text as string) : undefined;
      motionEntries.push({ tlStart: item.tlStart, type: spec.type, text });
    } catch {
      // sidecar missing/unreadable; skip this overlay for chapter purposes
    }
  }
  let chapterEntries = chaptersFromMotion(motionEntries);
  if (chapterEntries.length === 0) {
    const srcIds = [...new Set(segments(m).map((s) => s.sourceId))];
    for (const sourceId of srcIds) {
      const sceneFile = await project.scenes(sourceId);
      chapterEntries.push(...chaptersFromScenes(m, sceneFile));
    }
  }
  const assembled = assembleChapterLines(chapterEntries);

  const files: string[] = [];
  let chaptersFile: string | null = null;
  let chaptersReason: string | undefined;
  if (assembled.entries) {
    chaptersFile = path.join(outdir, 'chapters.txt');
    await fs.writeFile(chaptersFile, assembled.lines.join('\n') + '\n');
    files.push(chaptersFile);
  } else {
    chaptersReason = assembled.reason;
  }

  // ---- thumbnails ----
  const thumbsDir = path.join(outdir, 'thumbnails');
  await fs.mkdir(thumbsDir, { recursive: true });
  const peaksBySource = await loadPeaksBySource(project, m);
  const chapterTimes = assembled.entries?.map((e) => e.tlTime) ?? [];
  const points = selectThumbnailPoints(m, chapterTimes, peaksBySource, thumbsCount);

  const srcById = new Map(m.sources.map((s) => [s.id, s]));
  const output = m.output;
  const thumbnails: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const src = srcById.get(pt.sourceId);
    if (!src) continue;
    const geo = output ? cropGeometry(src.width, src.height, output.width, output.height, pt.crop) : null;
    const dest = path.join(thumbsDir, `thumb-${String(i + 1).padStart(2, '0')}-t${pt.tlTime.toFixed(1)}.jpg`);
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-ss', String(pt.srcTime),
      '-i', src.path,
      '-frames:v', '1',
      ...(geo ? ['-vf', `crop=${geo.width}:${geo.height}:${geo.x}:${geo.y}`] : []),
      '-q:v', '2',
      dest,
    ]);
    thumbnails.push(dest);
    files.push(dest);
  }

  // ---- materials.json ----
  const materials = buildMaterials(m, transcripts, assembled.lines ?? []);
  const materialsFile = path.join(outdir, 'materials.json');
  await fs.writeFile(materialsFile, JSON.stringify(materials, null, 2));
  files.push(materialsFile);

  return { outdir, files, chaptersFile, chaptersReason, thumbnails, materialsFile };
}
