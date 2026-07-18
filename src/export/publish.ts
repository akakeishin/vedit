import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  backgroundIntervals,
  COMP_SOURCE_ID,
  cropGeometry,
  keptWords,
  resolvedActiveSprites,
  segments,
  sourceTimeToTimeline,
  timelineDuration,
} from '../core/ops.js';
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
  /**
   * The source to extract this frame from — a real Manifest.sources[] id,
   * or (W-ANIME) the COMP_SOURCE_ID sentinel for a composition project,
   * which has no A-roll source at all. For a sentinel point, `srcTime` IS
   * the absolute timeline time (same convention as sourceTimeToTimeline's
   * `__comp__` branch) and extraction must come from a rendered file
   * (publishPack's `opts.renderedFile`) rather than an original source path.
   */
  sourceId: string;
  srcTime: number;
  crop?: { x?: number; y?: number };
  reason: 'chapter' | 'energy' | 'composition';
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
 *
 * A composition project (W-ANIME, `m.composition` set — see
 * selectCompositionThumbnailPoints below) never populates `timeline.video`,
 * so `segments(m)` is always empty and there is no waveform-energy signal
 * tied to an A-roll; it gets its own candidate logic entirely. Every
 * existing (source-driven) project is unaffected — `m.composition` is unset
 * for those, so this branch never activates and the rest of the function is
 * byte-for-byte unchanged.
 */
export function selectThumbnailPoints(
  m: Manifest,
  chapterTimes: number[],
  peaksBySource: Record<string, Peaks>,
  count: number,
): ThumbPoint[] {
  if (count <= 0) return [];
  if (m.composition) return selectCompositionThumbnailPoints(m, chapterTimes, count);

  const segs = segments(m);
  if (segs.length === 0) return [];
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

/**
 * Composition-mode (W-ANIME) thumbnail candidates — see selectThumbnailPoints
 * above. There is no A-roll and no waveform-energy signal to rank on, so the
 * candidate pool is every moment something visually changes: background-track
 * cut points (t=0 plus each `backgroundIntervals()` boundary — the "紙芝居"
 * scene changes) unioned with every resolved sprite's entrance time
 * (`resolvedActiveSprites()`'s tlStart). Chapter times (from motion
 * chapter-cards — the same list the source-driven path receives) still take
 * priority when present, using the same spacing/dedup rule (`minGap`) so
 * picks don't cluster. Every point is stamped `sourceId: COMP_SOURCE_ID`,
 * `srcTime: tlTime` — the same "srcTime IS absolute timeline time" sentinel
 * convention as `sourceTimeToTimeline` — since there is no per-source origin
 * to extract from; publishPack routes these to ffmpeg against a rendered
 * file (`opts.renderedFile`) instead of an original source path, or reports
 * a reason instead of silently producing zero thumbnails when none was
 * given. Pure, same contract as selectThumbnailPoints.
 */
function selectCompositionThumbnailPoints(m: Manifest, chapterTimes: number[], count: number): ThumbPoint[] {
  const duration = m.composition!.duration;
  if (!(duration > 0)) return [];

  const toPoint = (tl: number, reason: ThumbPoint['reason']): ThumbPoint => {
    const clampedTl = Math.min(Math.max(tl, 0), duration - 1e-6);
    return { tlTime: clampedTl, sourceId: COMP_SOURCE_ID, srcTime: clampedTl, reason };
  };

  const minGap = Math.max(0.5, duration / Math.max(1, count * 4));
  const chosen: ThumbPoint[] = [];
  const tooClose = (tl: number) => chosen.some((c) => Math.abs(c.tlTime - tl) < minGap);

  for (const tl of [...chapterTimes].sort((a, b) => a - b)) {
    if (chosen.length >= count) break;
    if (tl < 0 || tl >= duration) continue;
    if (tooClose(tl)) continue;
    chosen.push(toPoint(tl, 'chapter'));
  }

  const remaining = count - chosen.length;
  if (remaining > 0) {
    const boundaryTimes = backgroundIntervals(m).map((iv) => iv.t0);
    const spriteTimes = resolvedActiveSprites(m).map((r) => r.tlStart);
    const candidateTimes = [...new Set([...boundaryTimes, ...spriteTimes])]
      .filter((t) => t >= 0 && t < duration)
      .sort((a, b) => a - b);
    for (const tl of candidateTimes) {
      if (chosen.length >= count) break;
      if (tooClose(tl)) continue;
      chosen.push(toPoint(tl, 'composition'));
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

/**
 * Factual material for the director to draft a title/description from in
 * conversation — never a generated description itself. `sources` lists only
 * `kind !== 'image'` sources (i.e. real footage): an image-kind overlay
 * source (オーバーレイ・スタック, logo/photo/stamp material) carries a
 * synthetic `duration` (see IMAGE_SOURCE_DURATION in ingest.ts) that would
 * read as bogus/misleading "footage length" here — it isn't material for a
 * title/description in the way an actual filmed source is. Every project
 * with no image sources (i.e. every project before this feature existed) is
 * unaffected — full regression.
 */
export function buildMaterials(m: Manifest, transcripts: Transcript[], chapterLines: string[]): PublishMaterials {
  return {
    duration: timelineDuration(m),
    chapterList: chapterLines,
    sources: m.sources.filter((s) => s.kind !== 'image').map((s) => ({ file: path.basename(s.path), duration: s.duration })),
    keptWordCount: transcripts.reduce((a, t) => a + keptWords(m, t.sourceId, t.words).length, 0),
    captionsCueCount: captionCues(m, transcripts).length,
  };
}

// ---- orchestration (impure: fs + ffmpeg) ----

/** Exported for reuse by `vedit qc`'s tempoContractLite wiring (cli.ts) — same peaks-by-source shape qc.ts's tempoContractLite expects. */
export async function loadPeaksBySource(project: Project, m: Manifest): Promise<Record<string, Peaks>> {
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
  /**
   * Set (with `thumbnails` empty) when a composition project (W-ANIME) had
   * thumbnail candidates but no `opts.renderedFile` was given to extract
   * them from — guidance, not a failure: the rest of the pack (chapters,
   * materials.json) is still written normally. Unset for every
   * source-driven project (there's always an original source to extract
   * from) and for a composition pack that DID receive a renderedFile.
   */
  thumbnailsReason?: string;
  materialsFile: string;
}

/**
 * Full publish-pack pipeline: chapters (motion chapter-cards, else annotated
 * scenes) -> thumbnail candidate selection -> full-res JPG extraction ->
 * materials.json. For a source-driven project, thumbnails are extracted from
 * ORIGINAL sources (never proxies, so publish-quality stills). A composition
 * project (W-ANIME, `m.composition` set) has no source to extract from at
 * all — its candidate points are stamped with the COMP_SOURCE_ID sentinel
 * (see selectCompositionThumbnailPoints) and are extracted from
 * `opts.renderedFile` (an already-rendered output file, timeline-aligned by
 * construction) when given; when it's not given, thumbnail extraction is
 * skipped and `thumbnailsReason` explains why instead of silently producing
 * zero thumbnails. Entirely read-only with respect to the project (no
 * manifest mutation, no --base needed).
 */
export async function publishPack(
  project: Project,
  m: Manifest,
  transcripts: Transcript[],
  outdir: string,
  opts: { thumbs?: number; renderedFile?: string } = {},
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
  let thumbnailsReason: string | undefined;
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    // W-ANIME composition points have no original source to extract from at
    // all (see selectCompositionThumbnailPoints) — extract from a rendered
    // file when given, otherwise skip with an explicit reason rather than a
    // silent no-op. `thumbsCount` may legitimately mix in a `false`
    // opts.renderedFile with zero composition points (e.g. an empty
    // composition), so the reason is only ever set once we actually had a
    // point to skip.
    if (pt.sourceId === COMP_SOURCE_ID) {
      if (!opts.renderedFile) {
        thumbnailsReason ??=
          'コンポジション(スプライトアニメ)プロジェクトのサムネイル抽出にはレンダー済みファイルが必要です。' +
          '`vedit publish-pack <outdir> --render <file>` のように、書き出し済みファイルのパスを指定してください。';
        continue;
      }
      const dest = path.join(thumbsDir, `thumb-${String(i + 1).padStart(2, '0')}-t${pt.tlTime.toFixed(1)}.jpg`);
      await run('ffmpeg', [
        '-y', '-v', 'error',
        '-ss', String(pt.srcTime),
        '-i', opts.renderedFile,
        '-frames:v', '1',
        '-q:v', '2',
        dest,
      ]);
      thumbnails.push(dest);
      files.push(dest);
      continue;
    }
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

  return { outdir, files, chaptersFile, chaptersReason, thumbnails, thumbnailsReason, materialsFile };
}
