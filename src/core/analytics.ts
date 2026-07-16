// Phase 3 (W12): YouTube Analytics retrospective engine.
//
// Manual-CSV-import workflow only — there is no YouTube API integration
// here. The director exports "視聴者維持率" (audience retention) as CSV from
// YouTube Studio, and this module:
//   1. parses it despite YouTube's column-naming drift across locales/UI
//      revisions (parseRetentionCsv),
//   2. maps each retention sample (a position-% along the PUBLISHED video)
//      back onto the CURRENT project timeline, source footage, transcript
//      word, scene, and nearest motion chapter-card (mapRetentionToTimeline),
//   3. flags statistically notable drops/rises against local trend
//      (findDipsAndSpikes), keeping the first ~30s in its own "intro
//      drop-off" bucket since a steep decline there is normal YouTube
//      behavior, not an anomaly, and
//   4. assembles a structured, fact-only summary for the director
//      (buildRetrospective) — deliberately NOT a set of hypotheses; why a
//      dip happened is editorial judgment, not something this module infers.
//
// All functions are pure (no fs/network access) so they're testable against
// synthetic data; wiring this to `project.readMotionSpec` / on-disk CSV
// files is left to the caller (e.g. a future `vedit analytics` CLI command).

import type { Manifest, Scene, SceneFile, Transcript, Word } from './types.js';
import { timelineDuration, timelineTimeToSource } from './ops.js';

// ---- 1. CSV parsing ----

export interface RetentionPoint {
  /** 0..100, position along the PUBLISHED video (what the CSV's "video position" column means). */
  positionPct: number;
  /** 0..100, absolute audience retention at that position. */
  retentionPct: number;
}

// Known column-label variants, matched case-insensitively with collapsed
// whitespace. Exact matches are tried first; if none hit, a looser
// substring match (see classifyHeaderCell) catches most other phrasings
// YouTube Studio has shipped across locales/UI revisions.
const POSITION_HEADER_ALIASES = [
  '動画の位置 (%)',
  '動画の位置(%)',
  '動画の位置',
  'video position (%)',
  'video position(%)',
  'video position',
  'position (%)',
  'position(%)',
  'position_pct',
  'position',
].map(normalizeHeaderCell);

const RETENTION_HEADER_ALIASES = [
  '視聴者維持率 (%)',
  '視聴者維持率(%)',
  '視聴者維持率',
  '絶対視聴者維持率 (%)',
  '絶対視聴者維持率(%)',
  '絶対オーディエンス維持率 (%)',
  '絶対オーディエンス維持率(%)',
  'absolute audience retention (%)',
  'absolute audience retention(%)',
  'audience retention (%)',
  'audience retention(%)',
  'audience_retention_pct',
  'retention (%)',
  'retention(%)',
  'retention_pct',
  'retention',
].map(normalizeHeaderCell);

function normalizeHeaderCell(c: string): string {
  return c.trim().toLowerCase().replace(/\s+/g, ' ');
}

function classifyHeaderCell(norm: string): 'position' | 'retention' | null {
  if (POSITION_HEADER_ALIASES.includes(norm)) return 'position';
  if (RETENTION_HEADER_ALIASES.includes(norm)) return 'retention';
  // Looser fallback: any header mentioning "position" (or its Japanese
  // equivalent) that isn't otherwise recognized is very likely the position
  // column ("相対" variants etc.); same idea for "retention"/"維持率".
  if (/位置|position/.test(norm)) return 'position';
  if (/維持率|retention/.test(norm)) return 'retention';
  return null;
}

/** Split one CSV line into cells, honoring double-quoted fields (with "" escaping). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseNumericCell(c: string): number | null {
  const cleaned = c.trim().replace(/%/g, '').replace(/,/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a YouTube Studio "視聴者維持率" (audience retention) CSV export into
 * flat {positionPct, retentionPct} samples. Tolerant of:
 *  - locale (ja/en) and UI-revision column-name drift (see the alias tables
 *    above), matched by scanning the first ~20 lines for a header row rather
 *    than assuming line 1 (Studio exports sometimes carry no extra
 *    preamble, but this stays defensive against future changes);
 *  - extra/irrelevant columns (only the two matched columns are read);
 *  - position/retention expressed either as 0..100 or as a 0..1 fraction
 *    (detected by checking whether every value is <= 1, then scaling up);
 *  - quoted cells, thousands separators, and stray "%" suffixes on values.
 *
 * Throws a descriptive error (listing the header cells it actually saw) for
 * anything it doesn't recognize as a retention export at all.
 */
export function parseRetentionCsv(text: string): RetentionPoint[] {
  const stripped = text.replace(/^﻿/, '');
  const lines = stripped.split(/\r\n|\r|\n/);
  const maxScan = Math.min(lines.length, 20);

  let headerLineIndex = -1;
  let posIdx = -1;
  let retIdx = -1;
  let firstNonBlankCells: string[] | null = null;

  for (let i = 0; i < maxScan; i++) {
    const raw = lines[i];
    if (!raw || !raw.trim()) continue;
    const cells = splitCsvLine(raw);
    if (firstNonBlankCells === null) firstNonBlankCells = cells;
    let pIdx = -1;
    let rIdx = -1;
    for (let c = 0; c < cells.length; c++) {
      const kind = classifyHeaderCell(normalizeHeaderCell(cells[c]));
      if (kind === 'position' && pIdx === -1) pIdx = c;
      else if (kind === 'retention' && rIdx === -1) rIdx = c;
    }
    if (pIdx !== -1 && rIdx !== -1 && pIdx !== rIdx) {
      headerLineIndex = i;
      posIdx = pIdx;
      retIdx = rIdx;
      break;
    }
  }

  if (headerLineIndex === -1) {
    const found = (firstNonBlankCells ?? []).map((c) => c.trim()).filter(Boolean);
    throw new Error(
      `parseRetentionCsv: unrecognized retention CSV format` +
        (found.length ? ` — found columns: [${found.join(', ')}]` : ' — file has no readable header row') +
        `. Expected a position column (e.g. "動画の位置 (%)" / "Video position (%)") and a ` +
        `retention column (e.g. "視聴者維持率" / "Absolute audience retention (%)").`,
    );
  }

  const raw: { pos: number; ret: number }[] = [];
  for (let i = headerLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cells = splitCsvLine(line);
    if (cells.length <= Math.max(posIdx, retIdx)) continue;
    const pos = parseNumericCell(cells[posIdx]);
    const ret = parseNumericCell(cells[retIdx]);
    if (pos === null || ret === null) continue;
    raw.push({ pos, ret });
  }
  if (raw.length === 0) {
    throw new Error('parseRetentionCsv: matched a header row but found no numeric data rows beneath it');
  }

  const maxPos = Math.max(...raw.map((r) => r.pos));
  const maxRet = Math.max(...raw.map((r) => r.ret));
  const posScale = maxPos <= 1.0001 ? 100 : 1;
  const retScale = maxRet <= 1.0001 ? 100 : 1;

  return raw
    .map((r) => ({ positionPct: r.pos * posScale, retentionPct: r.ret * retScale }))
    .sort((a, b) => a.positionPct - b.positionPct);
}

// ---- 2. timeline mapping ----

/**
 * Minimal shape of a chapter marker, matching `ChapterEntry` from
 * src/export/publish.ts structurally (tlTime + title) without importing
 * from the export layer (core/ must not depend on export/). Callers that
 * already resolve chapter-card motion overlays via
 * `chaptersFromMotion(...)` (publish.ts) can pass that result straight in.
 */
export interface MotionChapterPoint {
  /** Timeline-domain seconds. */
  tlTime: number;
  title: string;
}

export interface MappedRetentionPoint extends RetentionPoint {
  /** Timeline-domain seconds, derived from positionPct * renderDurationSeconds. */
  tlTime: number;
  /** Source instant this timeline moment maps to, or null if it falls outside the current timeline (e.g. cut away since the analyzed render). */
  srcMoment: { sourceId: string; srcTime: number } | null;
  /** The transcript word at srcMoment (or nearest one, if none exactly covers it); null with no transcript for that source. */
  word: Word | null;
  /** The scene containing srcMoment, if scene data was supplied and covers it. */
  scene: Scene | null;
  /** The most recent chapter-card at or before this timeline moment, if chapter data was supplied. */
  chapter: MotionChapterPoint | null;
}

function findWordAt(transcripts: Transcript[], sourceId: string, srcTime: number): Word | null {
  const t = transcripts.find((tr) => tr.sourceId === sourceId);
  if (!t || t.words.length === 0) return null;
  const hit = t.words.find((w) => srcTime >= w.t0 && srcTime < w.t1);
  if (hit) return hit;
  let best: Word | null = null;
  let bestDist = Infinity;
  for (const w of t.words) {
    const dist = srcTime < w.t0 ? w.t0 - srcTime : srcTime - w.t1;
    if (dist < bestDist) {
      bestDist = dist;
      best = w;
    }
  }
  return best;
}

function findSceneAt(sceneFiles: SceneFile[] | undefined, sourceId: string, srcTime: number): Scene | null {
  const sf = sceneFiles?.find((s) => s.sourceId === sourceId);
  if (!sf) return null;
  return sf.scenes.find((sc) => srcTime >= sc.t0 && srcTime < sc.t1) ?? null;
}

function findChapterAt(chapters: MotionChapterPoint[] | undefined, tl: number): MotionChapterPoint | null {
  if (!chapters || chapters.length === 0) return null;
  let best: MotionChapterPoint | null = null;
  for (const c of chapters) {
    if (c.tlTime <= tl && (!best || c.tlTime > best.tlTime)) best = c;
  }
  return best;
}

/**
 * Map each retention sample (percent along the PUBLISHED/rendered video) to
 * the current project's timeline and, via `segments()`/`timelineTimeToSource`
 * (ops.ts), back to the source footage that produced it — plus whatever
 * transcript word, scene, and motion chapter-card were live at that instant.
 *
 * `renderDurationSeconds` is the duration of the video the CSV was exported
 * for. This assumes the manifest's current timeline still reflects (or
 * closely approximates) the cut that was actually published; if the project
 * has been re-edited heavily since, srcMoment attribution near the tail can
 * drift — there's no way to recover the original cut from retention data
 * alone, so this is a best-effort mapping, not a guarantee.
 */
export function mapRetentionToTimeline(
  points: RetentionPoint[],
  renderDurationSeconds: number,
  m: Manifest,
  transcripts: Transcript[],
  sceneFiles?: SceneFile[],
  chapters?: MotionChapterPoint[],
): MappedRetentionPoint[] {
  const totalDuration = timelineDuration(m);
  return points.map((p) => {
    let tl = (p.positionPct / 100) * renderDurationSeconds;
    if (!Number.isFinite(tl)) tl = 0;
    tl = Math.max(0, tl);

    let srcMoment: { sourceId: string; srcTime: number } | null = null;
    if (totalDuration > 0) {
      const probe = Math.min(tl, Math.max(0, totalDuration - 1e-6));
      srcMoment = timelineTimeToSource(m, probe);
    }

    const word = srcMoment ? findWordAt(transcripts, srcMoment.sourceId, srcMoment.srcTime) : null;
    const scene = srcMoment ? findSceneAt(sceneFiles, srcMoment.sourceId, srcMoment.srcTime) : null;
    const chapter = findChapterAt(chapters, tl);

    return { ...p, tlTime: tl, srcMoment, word, scene, chapter };
  });
}

// ---- 3. dip / spike detection ----

export interface DipSpikePoint {
  /** Index into the `points` array passed to findDipsAndSpikes — use this to cross-reference mapRetentionToTimeline's output. */
  index: number;
  positionPct: number;
  retentionPct: number;
  /** Local trend value (mean of neighboring samples, excluding this one) this point was compared against. */
  baselineRetentionPct: number;
  /** retentionPct - baselineRetentionPct (negative for dips, positive for spikes). */
  deltaPct: number;
}

export interface FindDipsAndSpikesOpts {
  /** Duration of the analyzed video, in seconds — needed to convert `introSeconds` into a position-% cutoff. Omit to disable the separate intro bucket (all points get scanned as "main"). */
  renderDurationSeconds?: number;
  /** Length of the "イントロ離脱" window, in seconds. Default 30. */
  introSeconds?: number;
  /** How many neighboring samples must be present on EACH side to score a point. Default 4. */
  windowSize?: number;
  /** Minimum drop below the local baseline (percentage points) to flag a dip. Default 4. */
  dipThresholdPct?: number;
  /** Minimum rise above the local baseline (percentage points) to flag a spike. Default 4. */
  spikeThresholdPct?: number;
}

export interface DipSpikeResult {
  /** Retention lost between the very first sample and the end of the intro window (0 if there isn't enough data to tell, or renderDurationSeconds was omitted). */
  introDropPct: number;
  dips: DipSpikePoint[];
  spikes: DipSpikePoint[];
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Flag samples whose retention deviates sharply from their local trend: a
 * `dip` fell well below the median of its neighbors, a `spike` rose (or
 * declined much less than) that median — usually a replay/rewatch moment.
 * The baseline is the MEDIAN (not mean) of the `windowSize` samples
 * immediately before and after the point (never the point itself), so a
 * single nearby outlier can't drag a neighbor's baseline along with it —
 * only a majority-anomalous neighborhood would. A point is only scored when
 * it has a FULL `windowSize` of samples on BOTH sides; points within
 * `windowSize` samples of the start/end of the post-intro series are
 * skipped rather than compared against a one-sided (and therefore
 * trend-biased) baseline.
 *
 * The first `introSeconds` (default 30) of the video are excluded from dip/
 * spike scanning entirely and instead summarized as `introDropPct`: YouTube
 * retention curves normally fall steeply in the first seconds as casual
 * clickers bounce, which is expected behavior, not an editorial anomaly
 * worth flagging alongside mid-video dips.
 */
export function findDipsAndSpikes(points: RetentionPoint[], opts: FindDipsAndSpikesOpts = {}): DipSpikeResult {
  if (points.length === 0) return { introDropPct: 0, dips: [], spikes: [] };

  const introSeconds = opts.introSeconds ?? 30;
  const windowSize = opts.windowSize ?? 4;
  const dipThresholdPct = opts.dipThresholdPct ?? 4;
  const spikeThresholdPct = opts.spikeThresholdPct ?? 4;

  const ordered = points.map((p, index) => ({ p, index })).sort((a, b) => a.p.positionPct - b.p.positionPct);

  let introCutoffPct = 0;
  if (opts.renderDurationSeconds && opts.renderDurationSeconds > 0) {
    introCutoffPct = Math.min(100, (introSeconds / opts.renderDurationSeconds) * 100);
  }

  const introEntries = ordered.filter((e) => e.p.positionPct <= introCutoffPct);
  const mainEntries = ordered.filter((e) => e.p.positionPct > introCutoffPct);

  let introDropPct = 0;
  if (introEntries.length > 0) {
    const first = ordered[0].p.retentionPct;
    const last = introEntries[introEntries.length - 1].p.retentionPct;
    introDropPct = Math.max(0, first - last);
  }

  const dips: DipSpikePoint[] = [];
  const spikes: DipSpikePoint[] = [];

  for (let i = 0; i < mainEntries.length; i++) {
    if (i - windowSize < 0 || i + windowSize >= mainEntries.length) continue; // insufficient symmetric context to judge trend
    const neighbors: number[] = [];
    for (let w = 1; w <= windowSize; w++) {
      neighbors.push(mainEntries[i - w].p.retentionPct);
      neighbors.push(mainEntries[i + w].p.retentionPct);
    }

    const baseline = median(neighbors);
    const current = mainEntries[i].p.retentionPct;
    const delta = current - baseline;

    const point: DipSpikePoint = {
      index: mainEntries[i].index,
      positionPct: mainEntries[i].p.positionPct,
      retentionPct: current,
      baselineRetentionPct: baseline,
      deltaPct: delta,
    };
    if (delta <= -dipThresholdPct) dips.push(point);
    else if (delta >= spikeThresholdPct) spikes.push(point);
  }

  return { introDropPct, dips, spikes };
}

// ---- 4. director-facing retrospective ----

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿]/u;
const isCjk = (s: string) => CJK_RE.test(s);

/** Join transcript words within `windowSec` of srcTime into a short evidence quote (or null if the source has no transcript / no words nearby). */
function nearbyQuote(transcripts: Transcript[], sourceId: string, srcTime: number, windowSec = 3): string | null {
  const t = transcripts.find((tr) => tr.sourceId === sourceId);
  if (!t) return null;
  const near = t.words
    .filter((w) => w.t1 >= srcTime - windowSec && w.t0 <= srcTime + windowSec)
    .sort((a, b) => a.t0 - b.t0);
  if (near.length === 0) return null;
  const join = near.some((w) => isCjk(w.text)) ? '' : ' ';
  const text = near.map((w) => w.text).join(join).trim();
  return text.length > 0 ? text : null;
}

export interface RetrospectiveEvent {
  positionPct: number;
  retentionPct: number;
  /** Signed deviation from local trend (percentage points); negative for dips, positive for spikes. */
  deltaPct: number;
  tlTime: number;
  srcMoment: { sourceId: string; srcTime: number } | null;
  /** Nearby transcript text as evidence (not interpretation), or null if unavailable. */
  quote: string | null;
  scene: Scene | null;
  chapter: MotionChapterPoint | null;
}

export interface Retrospective {
  introDropPct: number;
  dips: RetrospectiveEvent[];
  spikes: RetrospectiveEvent[];
}

/**
 * Full CSV-to-retrospective pipeline for the director: map every sample onto
 * the timeline/source/transcript/scene/chapter (mapRetentionToTimeline),
 * detect dips/spikes against local trend (findDipsAndSpikes), and attach
 * source-side evidence to each flagged point.
 *
 * Deliberately returns FACTS ONLY — no `hypotheses`/`reasons` field. Why a
 * dip happened (bad pacing? a cut people replayed past? an ad break?) is
 * editorial interpretation that belongs to the director, not something this
 * module guesses at.
 */
export function buildRetrospective(
  points: RetentionPoint[],
  renderDurationSeconds: number,
  m: Manifest,
  transcripts: Transcript[],
  sceneFiles?: SceneFile[],
  chapters?: MotionChapterPoint[],
  opts?: FindDipsAndSpikesOpts,
): Retrospective {
  const mapped = mapRetentionToTimeline(points, renderDurationSeconds, m, transcripts, sceneFiles, chapters);
  const { introDropPct, dips, spikes } = findDipsAndSpikes(points, { renderDurationSeconds, ...opts });

  const toEvent = (d: DipSpikePoint): RetrospectiveEvent => {
    const mp = mapped[d.index];
    return {
      positionPct: d.positionPct,
      retentionPct: d.retentionPct,
      deltaPct: d.deltaPct,
      tlTime: mp.tlTime,
      srcMoment: mp.srcMoment,
      quote: mp.srcMoment ? nearbyQuote(transcripts, mp.srcMoment.sourceId, mp.srcMoment.srcTime) : null,
      scene: mp.scene,
      chapter: mp.chapter,
    };
  };

  return {
    introDropPct,
    dips: dips.map(toEvent),
    spikes: spikes.map(toEvent),
  };
}
