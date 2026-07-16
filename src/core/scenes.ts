import path from 'node:path';
import { promises as fs } from 'node:fs';
import { keptWords } from './ops.js';
import type { Manifest, Scene, SceneFile, Word } from './types.js';
import type { Peaks } from './detect.js';
import type { Project } from './project.js';
import { run, runCapture } from '../ingest/run.js';

/**
 * Address footage that has no speech: a stable "scene id" per visual unit,
 * the visual counterpart of the word id used for transcript-driven cuts.
 * Detection here is deterministic (core); annotation (Scene.note) is a
 * separate model/human layer recorded with its provenance (`by`).
 */

function ts(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

// ---- detection: raw scene-change timestamps (ffmpeg, impure) ----

/**
 * Parse ffmpeg `showinfo` log lines (stderr) for `pts_time:` markers. Pure —
 * takes the captured text, not a media file, so it's testable without ffmpeg.
 */
export function parseSceneChangeTimes(showinfoOutput: string): number[] {
  const times = new Set<number>();
  const re = /pts_time:([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(showinfoOutput))) {
    times.add(Math.round(Number(m[1]) * 1000) / 1000);
  }
  return [...times].sort((a, b) => a - b);
}

/**
 * Run ffmpeg's scene-change detector against the proxy: `select='gt(scene,SENS)'`
 * flags frames whose difference from the previous frame exceeds `sensitivity`
 * (0..1); `showinfo` logs the timestamp of each selected frame to stderr.
 */
export async function detectSceneChangeTimes(mediaPath: string, sensitivity = 0.3): Promise<number[]> {
  const { stderr } = await runCapture('ffmpeg', [
    '-v', 'info',
    '-i', mediaPath,
    '-vf', `select='gt(scene,${sensitivity})',showinfo`,
    '-f', 'null', '-',
  ]);
  return parseSceneChangeTimes(stderr);
}

// ---- range building: split long takes, merge short fragments (pure) ----

export interface SceneRange {
  t0: number;
  t1: number;
}

/**
 * Merge any range shorter than `minLen` into a neighbor: forward into the
 * next range, or backward into the previous one when it's the last range.
 * Exported standalone so the merge behavior is testable on its own.
 */
export function mergeShortRanges(ranges: SceneRange[], minLen: number): SceneRange[] {
  const out = ranges.map((r) => ({ ...r }));
  let i = 0;
  while (out.length > 1 && i < out.length) {
    const len = out[i].t1 - out[i].t0;
    if (len >= minLen) {
      i++;
      continue;
    }
    if (i === out.length - 1) {
      out[i - 1] = { t0: out[i - 1].t0, t1: out[i].t1 };
      out.pop();
      i = Math.max(0, out.length - 1);
    } else {
      out[i] = { t0: out[i].t0, t1: out[i + 1].t1 };
      out.splice(i + 1, 1);
      // re-check index i: the merged range may still be under minLen
    }
  }
  return out;
}

/**
 * Turn raw scene-change boundary times into final scene ranges:
 *  1. bracket [0, duration] with the (deduped, sorted) boundary times
 *  2. split any range longer than maxLen into equal-length pieces (long
 *     single-shot takes, e.g. DJI vlog footage, under-trigger scene detection)
 *  3. merge any range shorter than minLen into a neighbor
 */
export function buildSceneRanges(
  duration: number,
  boundaryTimes: number[],
  opts: { maxLen?: number; minLen?: number } = {},
): SceneRange[] {
  const maxLen = opts.maxLen ?? 12;
  const minLen = opts.minLen ?? 1.5;
  if (duration <= 1e-6) return [];

  const pts = [...new Set(boundaryTimes.filter((t) => t > 1e-6 && t < duration - 1e-6))].sort((a, b) => a - b);
  const marks = [0, ...pts, duration];
  let ranges: SceneRange[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const t0 = marks[i];
    const t1 = marks[i + 1];
    if (t1 - t0 > 1e-6) ranges.push({ t0, t1 });
  }
  if (ranges.length === 0) ranges = [{ t0: 0, t1: duration }];

  ranges = ranges.flatMap((r) => {
    const len = r.t1 - r.t0;
    if (len <= maxLen) return [r];
    const n = Math.ceil(len / maxLen);
    const piece = len / n;
    return Array.from({ length: n }, (_, i) => ({ t0: r.t0 + i * piece, t1: r.t0 + (i + 1) * piece }));
  });

  return mergeShortRanges(ranges, minLen);
}

// ---- id continuity across re-detection (pure) ----

/**
 * Assign scene ids, reusing an existing scene's id when a new range's t0
 * lands within `tolerance` seconds of it — so re-detection (different
 * sensitivity, more footage trimmed, etc.) doesn't renumber scenes a user
 * has already annotated. Unmatched ranges get fresh ids continuing the
 * highest existing number, so ids never collide or get reused for a
 * different range.
 */
export function assignSceneIds(
  ranges: SceneRange[],
  existing: Pick<Scene, 'id' | 't0'>[] = [],
  tolerance = 0.5,
): (SceneRange & { id: string })[] {
  let maxNum = 0;
  for (const s of existing) {
    const m = /^s(\d+)$/.exec(s.id);
    if (m) maxNum = Math.max(maxNum, Number(m[1]));
  }
  const pool = [...existing];
  return ranges.map((r) => {
    const idx = pool.findIndex((e) => Math.abs(e.t0 - r.t0) <= tolerance);
    if (idx >= 0) {
      const [matched] = pool.splice(idx, 1);
      return { id: matched.id, ...r };
    }
    maxNum += 1;
    return { id: `s${String(maxNum).padStart(4, '0')}`, ...r };
  });
}

// ---- annotation-adjacent metrics (pure) ----

/** Whether any transcript word still on the timeline overlaps [t0, t1). */
export function computeHasSpeech(t0: number, t1: number, keptTranscriptWords: Word[]): boolean {
  return keptTranscriptWords.some((w) => w.t1 > t0 && w.t0 < t1);
}

/** Mean waveform peak over [t0, t1), as a motion proxy. */
export function computeEnergy(peaks: Peaks, t0: number, t1: number): number {
  const i0 = Math.max(0, Math.floor(t0 * peaks.rate));
  const i1 = Math.min(peaks.peaks.length, Math.ceil(t1 * peaks.rate));
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += peaks.peaks[i];
  return sum / (i1 - i0);
}

// ---- orchestration (impure: ffmpeg + project I/O) ----

export interface DetectScenesOpts {
  sensitivity?: number;
  maxLen?: number;
  minLen?: number;
}

/**
 * Full detect pipeline for one source: ffmpeg scene-change detection on the
 * proxy -> split/merge into final ranges -> id continuity against any
 * existing scenes file -> hasSpeech/energy from transcript+peaks -> thumbnail
 * per scene -> write scenes-<sourceId>.json. Existing notes are carried over
 * for scenes whose id was reused.
 */
export async function detectScenesForSource(
  project: Project,
  m: Manifest,
  sourceId: string,
  opts: DetectScenesOpts = {},
): Promise<SceneFile> {
  const src = m.sources.find((s) => s.id === sourceId);
  if (!src) throw new Error(`unknown source: ${sourceId}`);
  const media = src.proxy ? path.join(project.dir, src.proxy) : src.path;

  const existing = await project.scenes(sourceId);
  const times = await detectSceneChangeTimes(media, opts.sensitivity ?? 0.3);
  const ranges = buildSceneRanges(src.duration, times, opts);
  const withIds = assignSceneIds(ranges, existing.scenes);
  const existingById = new Map(existing.scenes.map((s) => [s.id, s]));

  let keptTranscriptWords: Word[] = [];
  if (src.transcribed) {
    try {
      const t = await project.transcript(sourceId);
      keptTranscriptWords = keptWords(m, sourceId, t.words);
    } catch { /* transcript flagged but file missing; treat as silent */ }
  }
  let peaks: Peaks | null = null;
  if (src.peaks) {
    try {
      peaks = JSON.parse(await fs.readFile(path.join(project.dir, src.peaks), 'utf8'));
    } catch { /* peaks flagged but file missing; treat as zero energy */ }
  }

  const scenes: Scene[] = [];
  for (const r of withIds) {
    const thumbRel = path.join('cache', `sc-${sourceId}-${r.id}.jpg`);
    const thumbAbs = path.join(project.dir, thumbRel);
    const mid = (r.t0 + r.t1) / 2;
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-ss', String(mid),
      '-i', media,
      '-frames:v', '1',
      '-vf', 'scale=160:-2',
      '-q:v', '4',
      thumbAbs,
    ]);
    scenes.push({
      id: r.id,
      t0: r.t0,
      t1: r.t1,
      thumb: thumbRel,
      hasSpeech: computeHasSpeech(r.t0, r.t1, keptTranscriptWords),
      energy: peaks ? computeEnergy(peaks, r.t0, r.t1) : 0,
      note: existingById.get(r.id)?.note,
    });
  }

  const file: SceneFile = { sourceId, scenes };
  await project.writeScenes(file);
  return file;
}

// ---- text rendering (pure) ----

/** Packed scene list: the compact text view Claude reads instead of raw JSON. */
export function packScenes(file: SceneFile): string {
  if (file.scenes.length === 0) return '(no scenes detected; run `vedit scenes detect`)';
  const lines = file.scenes.map((s) => {
    const dur = (s.t1 - s.t0).toFixed(1);
    const speech = s.hasSpeech ? 'speech' : 'silent';
    const energy = s.energy.toFixed(2);
    const note = s.note ? ` — ${s.note.text} (by:${s.note.by})` : '';
    return `${s.id} [${ts(s.t0)}–${ts(s.t1)}] ${dur}s ${speech} energy=${energy}${note}`;
  });
  const header = [
    `# scenes (source ${file.sourceId}, ${file.scenes.length} scenes)`,
    `# id [start–end] duration hasSpeech energy note`,
    `# use --scene <id> with clip-add / remove-range / view; annotate with \`vedit scenes note <id> "..." --by model\``,
  ];
  return [...header, ...lines].join('\n');
}
