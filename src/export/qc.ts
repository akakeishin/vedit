import { promises as fs } from 'node:fs';
import {
  COLOR_WARNING_MESSAGE,
  cullingStats,
  needsColorTransform,
  orphanedOverlays,
  orphanedSprites,
  segments,
  timelineDuration,
} from '../core/ops.js';
import { captionCues, type CaptionCue } from '../core/captions.js';
import { adaptiveThreshold, type Peaks } from '../core/detect.js';
import type { BackgroundRef, CutCandidate, KitAsset, KitProfile, Manifest, SceneFile, Source, Transcript } from '../core/types.js';
import { runCapture } from '../ingest/run.js';

/**
 * W9 — pre-publish QC engine + "tempo contract lite". Three independent
 * analyses, all read-only:
 *
 *  - staticChecks: manifest-level sanity checks that need no rendered file
 *    (pending review queues, orphans, caption density, color warnings,
 *    missing media, kit duration target).
 *  - probeRenderedFile: ffmpeg-probes an already-rendered file for the
 *    things a manifest alone can't tell you (actual black frames, actual
 *    silence, actual loudness/peak — see editorial-playbook.md's "全編の
 *    音量バランス・エンコード品質...を保証しない" caveat that this closes).
 *  - tempoContractLite: measured pacing facts vs. a kit's pacing
 *    declaration, presented WITHOUT a pass/fail verdict — matching a
 *    kit's average_shot_seconds number is not itself a merit, so this
 *    deliberately never gates anything (director judgment only).
 *
 * buildQcReport renders all three into one self-contained HTML string.
 * Wiring this into `vedit` (CLI/daemon commands, actually invoking a
 * render + probe, persisting intentZones on the manifest) is later-wave
 * work; this module only computes/parses/renders.
 */

// ---------------------------------------------------------------------------
// ---- shared issue shape ----------------------------------------------------
// ---------------------------------------------------------------------------

export type QcSeverity = 'error' | 'warning' | 'info';

export type QcCategory =
  | 'candidates'
  | 'scene-review'
  | 'overlay-orphan'
  | 'sprite-orphan'
  | 'captions'
  | 'color'
  | 'source-missing'
  | 'kit-duration'
  | 'kit-asset-missing';

export interface QcIssue {
  id: string;
  severity: QcSeverity;
  category: QcCategory;
  message: string;
  /** Timeline seconds this issue concerns, when applicable — carried through to buildQcReport's `data-tl` attribute (click-to-seek wiring is a later wave). */
  tlTime?: number;
}

/** Small id+push factory shared by every check* function below — ids are `<category>-<n>`, unique within one report without needing a global counter (and therefore deterministic/test-friendly). */
function issueList(category: QcCategory) {
  const issues: QcIssue[] = [];
  const push = (severity: QcSeverity, message: string, tlTime?: number): void => {
    issues.push({ id: `${category}-${issues.length + 1}`, severity, category, message, ...(tlTime !== undefined ? { tlTime } : {}) });
  };
  return { issues, push };
}

// ---------------------------------------------------------------------------
// ---- staticChecks: individual branches (pure, except checkMediaFilesExist) -
// ---------------------------------------------------------------------------

/**
 * Two independent "still needs a human decision" queues: the cut-candidate
 * approve/reject queue (proposed silences/fillers, see detect.ts +
 * project.ts's candidates.json) and the scene-culling keep/reject/unreviewed
 * queue (see ops.ts's cullingStats). Either one left non-empty means the
 * project isn't actually done being edited yet, regardless of how the
 * timeline currently looks — worth surfacing before a publish render.
 * `candidates`/`sceneFiles` are each independently optional: a caller that
 * only tracks one queue (or neither) still gets a useful result.
 */
export function checkPendingQueues(m: Manifest, sceneFiles: SceneFile[], candidates: CutCandidate[]): QcIssue[] {
  const { issues, push } = issueList('candidates');
  const pending = candidates.filter((c) => c.status === 'proposed');
  if (pending.length > 0) {
    push('warning', `${pending.length}件の未処理カット候補があります(vedit candidates で確認)`);
  }
  if (sceneFiles.length > 0) {
    const { totals } = cullingStats(m, sceneFiles);
    if (totals.unreviewed > 0) {
      const scene = issueList('scene-review');
      scene.push('info', `${totals.unreviewed}件の未レビューシーンがあります(vedit review-status で確認)`);
      issues.push(...scene.issues);
    }
  }
  return issues;
}

/** B-roll overlays / kit sprites whose anchor got cut away — mirrors ops.ts's orphanedOverlays/orphanedSprites, one issue per orphan. */
export function checkOrphans(m: Manifest): QcIssue[] {
  const overlay = issueList('overlay-orphan');
  for (const o of orphanedOverlays(m)) overlay.push('error', `B-rollオーバーレイ ${o.id} が orphan です — ${o.reason}`);
  const sprite = issueList('sprite-orphan');
  for (const s of orphanedSprites(m)) sprite.push('error', `スプライト ${s.id} が orphan です — ${s.reason}`);
  return [...overlay.issues, ...sprite.issues];
}

/**
 * Caption-cue sanity check over an already-computed cue list (pass
 * `captionCues(m, transcripts)` in — kept as a plain array param rather than
 * taking `m`/`transcripts` itself so this stays trivially testable with
 * hand-built cue fixtures, including ones captionCues itself would never
 * actually produce). Two independent checks:
 *  - overlap: cues[i].tlEnd must not exceed cues[i+1].tlStart. captionCues
 *    already de-overlaps by construction, so in the normal pipeline this
 *    should never fire — it's a defensive belt-and-suspenders check for a
 *    future caller that feeds cues from somewhere else, or a regression in
 *    captionCues itself.
 *  - overrun: characters-per-second above `maxCps` (mirrors
 *    CaptionSettings.maxCps / captions.ts's enforceMinDisplay target) —
 *    enforceMinDisplay tries to keep every cue under this, but a long
 *    sentence merged against a hard next-cue boundary can still exceed it.
 */
export function checkCaptionCues(cues: CaptionCue[], maxCps: number): QcIssue[] {
  const { issues, push } = issueList('captions');
  const clip = (s: string, n = 20) => (s.length > n ? `${s.slice(0, n)}…` : s);
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const dur = c.tlEnd - c.tlStart;
    const cps = dur > 0 ? c.text.length / dur : Infinity;
    if (cps > maxCps + 1e-6) {
      push('warning', `字幕が速すぎます(${cps.toFixed(1)} cps > ${maxCps}): "${clip(c.text)}"`, c.tlStart);
    }
    const next = cues[i + 1];
    if (next && c.tlEnd > next.tlStart + 1e-6) {
      push('error', `字幕が重複しています: "${clip(c.text)}" が次のcueと重なっています`, c.tlStart);
    }
  }
  return issues;
}

/** Sources whose captured color metadata implies untransformed Log/HLG/PQ material (see ops.ts's needsColorTransform). Reuses the exact COLOR_WARNING_MESSAGE surfaced elsewhere (vedit status/resume) so the wording stays consistent. */
export function checkColorWarnings(sources: Source[]): QcIssue[] {
  const { issues, push } = issueList('color');
  for (const s of sources) {
    if (needsColorTransform(s.color)) push('warning', `${s.id}: ${COLOR_WARNING_MESSAGE}`);
  }
  return issues;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every video source and BGM file's path (Source.path / MusicItem.path —
 * both documented as "absolute path to the original media/music file, never
 * modified") must still exist on disk, or a publish render will fail
 * partway through. Impure (the one static check that does real I/O, per the
 * spec) but still read-only and safe to run anytime.
 */
export async function checkMediaFilesExist(m: Manifest): Promise<QcIssue[]> {
  const { issues, push } = issueList('source-missing');
  const files: { id: string; path: string; kind: string }[] = [
    ...m.sources.map((s) => ({ id: s.id, path: s.path, kind: 'ソース' })),
    ...(m.timeline.music ?? []).map((mu) => ({ id: mu.id, path: mu.path, kind: 'BGM' })),
  ];
  for (const f of files) {
    if (!(await pathExists(f.path))) {
      push('error', `${f.kind} ${f.id} のファイルが見つかりません: ${f.path}`);
    }
  }
  return issues;
}

/**
 * W-ANIME: every kit-asset REFERENCE a composition (or a normal project's
 * sprites) makes — `composition.background`/`backgroundTrack[].ref` (when
 * their `type` is `'asset'`), every `SpriteItem.assetId`, and every
 * `SpriteItem.motion.emoteAt[].assetId` — must resolve against the linked
 * kit's `assets[]`. `kitAssets` is the caller's already-loaded
 * `kit.assets` (same "caller loads kit.json, this stays I/O-free"
 * division of labor as checkKitDuration's `kitProfile`); `undefined` means
 * "the kit couldn't be loaded" and this check is skipped entirely (an
 * unloadable kit is `checkKitDuration`'s/render's problem to warn about,
 * not a reason to flood every reference here as "missing"). No `m.kit` at
 * all also skips — nothing to check against.
 */
export function checkKitAssetReferences(m: Manifest, kitAssets: KitAsset[] | undefined): QcIssue[] {
  const { issues, push } = issueList('kit-asset-missing');
  if (!m.kit || kitAssets === undefined) return issues;
  const known = new Set(kitAssets.map((a) => a.id));
  const checkRef = (label: string, ref: BackgroundRef | undefined) => {
    if (ref?.type === 'asset' && !known.has(ref.assetId)) {
      push('error', `${label}: kit素材が見つかりません: ${ref.assetId}`);
    }
  };
  if (m.composition) {
    checkRef('背景', m.composition.background);
    for (const e of m.composition.backgroundTrack ?? []) checkRef(`背景切替(t=${e.t.toFixed(1)}s)`, e.ref);
  }
  for (const s of m.timeline.sprites ?? []) {
    if (!known.has(s.assetId)) push('error', `スプライト ${s.id}: kit素材が見つかりません: ${s.assetId}`);
    for (const e of s.motion?.emoteAt ?? []) {
      if (!known.has(e.assetId)) {
        push('error', `スプライト ${s.id} の emoteAt(t=${e.t.toFixed(1)}s): kit素材が見つかりません: ${e.assetId}`);
      }
    }
  }
  return issues;
}

/**
 * Diff the current timeline duration against a linked kit's declared
 * duration_seconds target/min/max (KitProfile.duration_seconds — see
 * types.ts). Only fires when the project actually links a kit
 * (`m.kit` set) AND the caller supplied that kit's already-loaded profile
 * (same "kit.json read by the caller, this function stays I/O-free"
 * division of labor as buildResume/toAss/renderFinal use for kit data).
 * ±10% of `target` is a warning per the spec; `min`/`max`, when present, are
 * hard bounds checked independently of the ±10% band.
 */
export function checkKitDuration(m: Manifest, actualDurationSeconds: number, kitProfile?: KitProfile | null): QcIssue[] {
  const { issues, push } = issueList('kit-duration');
  if (!m.kit || !kitProfile?.duration_seconds) return issues;
  const { min, max, target } = kitProfile.duration_seconds;
  if (target !== undefined && target > 0) {
    const deltaPct = ((actualDurationSeconds - target) / target) * 100;
    if (Math.abs(deltaPct) > 10) {
      const sign = deltaPct > 0 ? '+' : '';
      push(
        'warning',
        `尺がキット目標から${sign}${deltaPct.toFixed(1)}%乖離しています(実測${actualDurationSeconds.toFixed(1)}s / 目標${target}s)`,
      );
    }
  }
  if (min !== undefined && actualDurationSeconds < min) {
    push('warning', `尺(${actualDurationSeconds.toFixed(1)}s)がキット下限(${min}s)を下回っています`);
  }
  if (max !== undefined && actualDurationSeconds > max) {
    push('warning', `尺(${actualDurationSeconds.toFixed(1)}s)がキット上限(${max}s)を超えています`);
  }
  return issues;
}

export interface StaticCheckReport {
  issues: QcIssue[];
  counts: { errors: number; warnings: number; infos: number };
}

/**
 * Full manifest-level QC pass — orchestrates every check* function above.
 * `sceneFiles` (scene-culling review queue) is optional and defaults to
 * none; `opts.candidates` (cut-candidate approve/reject queue) and
 * `opts.kitProfile` (an already-loaded KitFile.profile, see
 * checkKitDuration) are likewise optional — omitting any of them simply
 * skips the checks that need it rather than erroring, matching this
 * codebase's "書いた分だけ効く" convention for optional inputs (see kit.ts).
 */
export async function staticChecks(
  m: Manifest,
  transcripts: Transcript[],
  sceneFiles: SceneFile[] = [],
  opts: { candidates?: CutCandidate[]; kitProfile?: KitProfile | null; kitAssets?: KitAsset[] } = {},
): Promise<StaticCheckReport> {
  const cues = captionCues(m, transcripts);
  const maxCps = m.captions.maxCps ?? 8;
  // W-ANIME: timelineDuration(m) already accounts for Manifest.composition
  // (segments()-based duration is always 0 for a composition project, since
  // it never populates timeline.video) — using it here (rather than
  // re-deriving the same segments() sum by hand, as before) makes
  // checkKitDuration meaningful for composition projects too, with no
  // behavior change for normal ones (timelineDuration falls through to the
  // exact same segments() sum when m.composition is unset).
  const durationSeconds = timelineDuration(m);

  const issues: QcIssue[] = [
    ...checkPendingQueues(m, sceneFiles, opts.candidates ?? []),
    ...checkOrphans(m),
    ...checkCaptionCues(cues, maxCps),
    ...checkColorWarnings(m.sources),
    ...(await checkMediaFilesExist(m)),
    ...checkKitDuration(m, durationSeconds, opts.kitProfile),
    ...checkKitAssetReferences(m, opts.kitAssets),
  ];

  return {
    issues,
    counts: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      infos: issues.filter((i) => i.severity === 'info').length,
    },
  };
}

// ---------------------------------------------------------------------------
// ---- probeRenderedFile: ffmpeg stderr parsers (pure) + orchestration ------
// ---------------------------------------------------------------------------

/** ffmpeg's `-inf`/`inf`/`nan` tokens -> real numbers (or null for `nan`, which is genuinely "no value"). */
function parseFfNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  if (t === 'nan') return null;
  if (t === '-inf') return -Infinity;
  if (t === 'inf' || t === '+inf') return Infinity;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface BlackWindow {
  start: number;
  end: number;
  duration: number;
}

/**
 * Parse ffmpeg's `blackdetect` filter log lines, e.g.
 * `black_start:12.0 black_end:14.5 black_duration:2.5` (one line per
 * completed black interval — blackdetect only logs once the interval
 * ends). Matched by content, not by the `[Parsed_blackdetect_N @ 0x...]`
 * prefix, since that prefix's index/pointer vary run to run.
 */
export function parseBlackDetect(stderr: string): BlackWindow[] {
  const out: BlackWindow[] = [];
  const re = /black_start:(-?[\d.]+)\s+black_end:(-?[\d.]+)\s+black_duration:(-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    out.push({ start: Number(m[1]), end: Number(m[2]), duration: Number(m[3]) });
  }
  return out;
}

export interface SilenceWindow {
  start: number;
  /** null when the stream ends while still silent (no matching `silence_end` was ever logged). */
  end: number | null;
  duration: number | null;
}

/**
 * Parse ffmpeg's `silencedetect` filter log lines: `silence_start: T` and
 * `silence_end: T | silence_duration: D`, logged as two SEPARATE lines
 * (entering vs. leaving silence) and paired here in stream order. A
 * trailing unmatched `silence_start` (file ends mid-silence) becomes a
 * window with `end`/`duration` null rather than being dropped.
 */
export function parseSilenceDetect(stderr: string): SilenceWindow[] {
  const out: SilenceWindow[] = [];
  const re = /silence_(start|end):\s*(-?[\d.]+)(?:\s*\|\s*silence_duration:\s*(-?[\d.]+))?/g;
  let pending: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) {
    const t = Number(m[2]);
    if (m[1] === 'start') {
      if (pending !== null) out.push({ start: pending, end: null, duration: null }); // defensive: two starts in a row, shouldn't happen
      pending = t;
    } else if (pending !== null) {
      out.push({ start: pending, end: t, duration: m[3] !== undefined ? Number(m[3]) : t - pending });
      pending = null;
    } // else: an `end` with no matching `start` — defensive no-op, shouldn't happen
  }
  if (pending !== null) out.push({ start: pending, end: null, duration: null });
  return out;
}

export interface LoudnessSummary {
  integratedLufs: number | null;
  integratedThresholdLufs: number | null;
  loudnessRangeLu: number | null;
  /** Only populated when the ebur128 filter ran with `peak=true`/`peak=histogram` — otherwise ffmpeg's summary omits the "True peak:" section and this stays null. */
  truePeakDb: number | null;
}

/**
 * Parse ffmpeg's `ebur128` filter final "Summary:" block (NOT the
 * per-frame progress lines that precede it during the run, e.g.
 * `t: 1.2 ... I: -22 LUFS` — those use a completely different layout and
 * are ignored by anchoring the search on the LAST "Summary:" marker, which
 * ebur128 only logs once, at uninit).
 */
export function parseEbur128Summary(stderr: string): LoudnessSummary {
  const idx = stderr.lastIndexOf('Summary:');
  const summary = idx >= 0 ? stderr.slice(idx) : '';
  const section = (marker: string): string | undefined => {
    const m = summary.match(new RegExp(`${marker}:([\\s\\S]*?)(?:\\n\\s*\\n|$)`));
    return m?.[1];
  };
  const grab = (block: string | undefined, key: string, unit: string): number | null => {
    if (!block) return null;
    const m = block.match(new RegExp(`\\b${key}:\\s*(-?[\\d.]+|-inf|inf|nan)\\s*${unit}`, 'i'));
    return m ? parseFfNumber(m[1]) : null;
  };
  const integrated = section('Integrated loudness');
  const range = section('Loudness range');
  const peak = section('True peak');
  return {
    integratedLufs: grab(integrated, 'I', 'LUFS'),
    integratedThresholdLufs: grab(integrated, 'Threshold', 'LUFS'),
    loudnessRangeLu: grab(range, 'LRA', 'LU'),
    truePeakDb: grab(peak, 'Peak', 'dBFS'),
  };
}

export interface AstatsSummary {
  peakDb: number | null;
  rmsDb: number | null;
  /** astats' "Peak count" (times the signal reached the measured peak level) — used as a clipping proxy alongside peakDb; astats has no dedicated "clip count" metric. */
  peakCount: number | null;
  noiseFloorDb: number | null;
}

/**
 * Parse ffmpeg's `astats` filter combined stats. astats logs one
 * "Channel: N" block per channel followed by a final "Overall" block, all
 * sharing the same metric key names — rather than textually bounding the
 * "Overall" section (fragile across mono/stereo/multi-channel and ffmpeg
 * versions), this takes the LAST occurrence of each key in the whole
 * stderr, which is always the Overall block's value since ffmpeg emits it
 * last (verified against real ffmpeg 8.1 output — see qc.test.ts fixture).
 */
export function parseAstatsOverall(stderr: string): AstatsSummary {
  const lastNumber = (re: RegExp): number | null => {
    let m: RegExpExecArray | null;
    let last: number | null = null;
    while ((m = re.exec(stderr))) last = parseFfNumber(m[1]);
    return last;
  };
  return {
    peakDb: lastNumber(/Peak level dB:\s*(-?[\d.]+|-inf|inf|nan)/gi),
    rmsDb: lastNumber(/RMS level dB:\s*(-?[\d.]+|-inf|inf|nan)/gi),
    peakCount: lastNumber(/Peak count:\s*(-?[\d.]+|-inf|inf|nan)/gi),
    noiseFloorDb: lastNumber(/Noise floor dB:\s*(-?[\d.]+|-inf|inf|nan)/gi),
  };
}

/** A deliberate black/silent stretch (fade-to-black transition, dramatic pause) that shouldn't be flagged as a defect. Not yet a real manifest field — spec calls for accepting it as a plain argument now so a future `Manifest.intentZones` (or similar) can be threaded straight through without an API change here. */
export interface IntentZone {
  t0: number;
  t1: number;
  reason?: string;
}

/** Fraction of [t0,t1) covered by any zone in `zones`, 0..1. */
function coverageFraction(t0: number, t1: number, zones: IntentZone[]): number {
  const dur = Math.max(1e-9, t1 - t0);
  let covered = 0;
  for (const z of zones) {
    const a = Math.max(t0, z.t0);
    const b = Math.min(t1, z.t1);
    if (b > a) covered += b - a;
  }
  return Math.min(1, covered / dur);
}

export interface ProbeIssue {
  kind: 'black' | 'silence' | 'loudness' | 'true-peak' | 'clipping';
  severity: QcSeverity;
  message: string;
  t0?: number;
  t1?: number;
}

export interface ProbeRenderedFileResult {
  /** Every detected black window, regardless of intentZones — always the complete list. */
  black: BlackWindow[];
  /** Every detected silence window, regardless of intentZones — always the complete list. */
  silence: SilenceWindow[];
  loudness: LoudnessSummary;
  audio: AstatsSummary;
  /** Derived, actionable findings: black/silence windows >=50% covered by an intentZone are excluded here (but still present in `black`/`silence` above), plus loudness/peak/clipping thresholds. */
  issues: ProbeIssue[];
}

const DEFAULT_BLACK_DURATION = 0.5;
const DEFAULT_SILENCE_THRESHOLD_DB = -50;
const DEFAULT_SILENCE_DURATION = 1;
/** How much of a detected black/silence window must fall inside an intentZone before it's treated as deliberate rather than a defect. */
const INTENT_COVERAGE_THRESHOLD = 0.5;
/** loudnorm's own TP target (see render.ts's loudnormClause: `TP=-1.5`) — a rendered file's measured true peak above this has slipped past the safety margin loudnorm was supposed to enforce. */
const TRUE_PEAK_CEILING_DB = -1.5;
/** A sample at/within this many dB of 0dBFS is treated as clipped/near-clipped. */
const CLIPPING_PEAK_DB = -0.3;

/**
 * ffmpeg-probe a finished render for defects a manifest alone can't reveal:
 * actual black frames, actual silence, actual integrated loudness/true peak/
 * clipping. Single ffmpeg invocation (blackdetect on video, silencedetect +
 * ebur128 + astats chained on audio — all four are pass-through analysis
 * filters, so they can share one `-f null -` pass) whose stderr is parsed by
 * the pure functions above.
 */
export async function probeRenderedFile(
  filePath: string,
  opts: {
    intentZones?: IntentZone[];
    blackDuration?: number;
    silenceThresholdDb?: number;
    silenceDuration?: number;
    /** Compared against the measured integrated LUFS to flag a >1LU miss; default -14 (render.ts/audioMix's own default target). */
    targetLufs?: number;
  } = {},
): Promise<ProbeRenderedFileResult> {
  const blackD = opts.blackDuration ?? DEFAULT_BLACK_DURATION;
  const silDb = opts.silenceThresholdDb ?? DEFAULT_SILENCE_THRESHOLD_DB;
  const silD = opts.silenceDuration ?? DEFAULT_SILENCE_DURATION;
  const zones = opts.intentZones ?? [];
  const targetLufs = opts.targetLufs ?? -14;

  const graph =
    `[0:v]blackdetect=d=${blackD}:pix_th=0.10[vout];` +
    `[0:a]silencedetect=n=${silDb}dB:d=${silD},ebur128=peak=true,astats=metadata=0:reset=0[aout]`;
  const { stderr } = await runCapture('ffmpeg', [
    '-i', filePath,
    '-filter_complex', graph,
    '-map', '[vout]', '-map', '[aout]',
    '-f', 'null', '-',
  ]);

  const black = parseBlackDetect(stderr);
  const silence = parseSilenceDetect(stderr);
  const loudness = parseEbur128Summary(stderr);
  const audio = parseAstatsOverall(stderr);

  const issues: ProbeIssue[] = [];
  for (const b of black) {
    if (coverageFraction(b.start, b.end, zones) >= INTENT_COVERAGE_THRESHOLD) continue;
    issues.push({
      kind: 'black', severity: 'warning',
      message: `${b.duration.toFixed(1)}秒の暗転を検出 (${b.start.toFixed(1)}s-${b.end.toFixed(1)}s)`,
      t0: b.start, t1: b.end,
    });
  }
  for (const s of silence) {
    const end = s.end ?? s.start;
    if (coverageFraction(s.start, end, zones) >= INTENT_COVERAGE_THRESHOLD) continue;
    const dur = s.duration;
    const range = s.end !== null ? `${s.start.toFixed(1)}s-${s.end.toFixed(1)}s` : `${s.start.toFixed(1)}s〜末尾`;
    issues.push({
      kind: 'silence', severity: 'info',
      message: `${dur !== null ? `${dur.toFixed(1)}秒の` : ''}無音を検出 (${range})`,
      t0: s.start, ...(s.end !== null ? { t1: s.end } : {}),
    });
  }
  if (loudness.integratedLufs !== null && Math.abs(loudness.integratedLufs - targetLufs) > 1) {
    issues.push({
      kind: 'loudness', severity: 'warning',
      message: `統合ラウドネス ${loudness.integratedLufs.toFixed(1)} LUFS が目標 ${targetLufs} LUFS から乖離しています`,
    });
  }
  if (loudness.truePeakDb !== null && loudness.truePeakDb > TRUE_PEAK_CEILING_DB) {
    issues.push({
      kind: 'true-peak', severity: 'warning',
      message: `トゥルーピーク ${loudness.truePeakDb.toFixed(1)} dBFS が安全マージン ${TRUE_PEAK_CEILING_DB}dBFS を超えています`,
    });
  }
  if (audio.peakDb !== null && audio.peakDb >= CLIPPING_PEAK_DB) {
    issues.push({
      kind: 'clipping', severity: 'error',
      message: `音声クリッピングの疑いがあります(ピーク ${audio.peakDb.toFixed(1)}dB, peak count ${audio.peakCount ?? '不明'})`,
    });
  }

  return { black, silence, loudness, audio, issues };
}

// ---------------------------------------------------------------------------
// ---- tempoContractLite: measured facts vs. kit pacing, no verdict ---------
// ---------------------------------------------------------------------------

export interface ShotLengthStats {
  count: number;
  meanSeconds: number;
  minSeconds: number;
  maxSeconds: number;
  medianSeconds: number;
}

function shotLengthStats(lengths: number[]): ShotLengthStats | null {
  if (lengths.length === 0) return null;
  const sorted = [...lengths].sort((a, b) => a - b);
  const sum = lengths.reduce((a, b) => a + b, 0);
  const mid = Math.floor(sorted.length / 2);
  const medianSeconds = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { count: lengths.length, meanSeconds: sum / lengths.length, minSeconds: sorted[0], maxSeconds: sorted[sorted.length - 1], medianSeconds };
}

/**
 * Fraction of sampled kept-timeline peaks below a silence threshold —
 * reuses detect.ts's `adaptiveThreshold` (the same threshold-picking logic
 * the approve-queue's waveform silence detector uses) per source unless
 * `silenceThreshold` overrides it globally. Mirrors publish.ts's
 * `selectThumbnailPoints` for how a segment's kept source range maps onto
 * `Peaks` sample indices.
 */
function silenceRatioFromPeaks(m: Manifest, peaksBySource: Record<string, Peaks>, silenceThreshold?: number): number | null {
  let total = 0;
  let silent = 0;
  for (const seg of segments(m)) {
    const peaks = peaksBySource[seg.sourceId];
    if (!peaks || peaks.peaks.length === 0 || peaks.rate <= 0) continue;
    const thr = silenceThreshold ?? adaptiveThreshold(peaks.peaks);
    const dur = seg.tlEnd - seg.tlStart;
    const i0 = Math.max(0, Math.floor(seg.srcStart * peaks.rate));
    const i1 = Math.min(peaks.peaks.length, Math.ceil((seg.srcStart + dur) * peaks.rate));
    for (let i = i0; i < i1; i++) {
      total++;
      if (peaks.peaks[i] < thr) silent++;
    }
  }
  return total > 0 ? silent / total : null;
}

export interface TempoFacts {
  /** Measured shot-length distribution from the current timeline (one "shot" = one contiguous kept clip on the A-roll — see ops.ts's `segments`); null on an empty timeline. */
  shotLengths: ShotLengthStats | null;
  /** Fraction of sampled audio below the silence threshold, when peaks were supplied; null otherwise. */
  silenceRatio: number | null;
  /** The kit's declared pacing.average_shot_seconds, or null when no kitProfile (or no pacing section) was given. */
  kitAverageShotSeconds: number | null;
  /** shotLengths.meanSeconds - kitAverageShotSeconds; null unless both are available. */
  deltaSeconds: number | null;
  deltaPercent: number | null;
}

/**
 * Measured cut-density + dead-air facts, diffed against a kit's pacing
 * declaration when given — deliberately returns no pass/fail verdict.
 * Matching a kit's average_shot_seconds exactly is not itself a merit
 * (design decision per the W9 spec: "数値合わせの強制をしない") — this is
 * display-only material for the director's own judgment, same spirit as
 * kitProfileHighlights in kit.ts just surfacing the profile rather than
 * enforcing it.
 */
export function tempoContractLite(
  m: Manifest,
  kitProfile?: KitProfile | null,
  opts: { peaksBySource?: Record<string, Peaks>; silenceThreshold?: number } = {},
): TempoFacts {
  const shotLengths = shotLengthStats(segments(m).map((s) => s.tlEnd - s.tlStart));
  const silenceRatio = opts.peaksBySource ? silenceRatioFromPeaks(m, opts.peaksBySource, opts.silenceThreshold) : null;
  const kitAverageShotSeconds = kitProfile?.pacing?.average_shot_seconds ?? null;
  const deltaSeconds = shotLengths && kitAverageShotSeconds !== null ? shotLengths.meanSeconds - kitAverageShotSeconds : null;
  const deltaPercent = deltaSeconds !== null && kitAverageShotSeconds ? (deltaSeconds / kitAverageShotSeconds) * 100 : null;
  return { shotLengths, silenceRatio, kitAverageShotSeconds, deltaSeconds, deltaPercent };
}

// ---------------------------------------------------------------------------
// ---- buildQcReport: self-contained HTML ------------------------------------
// ---------------------------------------------------------------------------

export interface QcReportInput {
  title?: string;
  /** ISO timestamp; defaults to `new Date().toISOString()`. */
  generatedAt?: string;
  staticReport?: StaticCheckReport;
  probe?: ProbeRenderedFileResult;
  tempo?: TempoFacts;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sevRank(s: QcSeverity): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}
function sevLabel(s: QcSeverity): string {
  return s === 'error' ? 'ERROR' : s === 'warning' ? 'WARN' : 'INFO';
}

/** "1:23.4" timeline-time format for the report's issue table (seconds omitted when undefined). */
function fmtTl(t: number | undefined): string {
  if (t === undefined || !Number.isFinite(t)) return '—';
  const mm = Math.floor(t / 60);
  const ss = (t % 60).toFixed(1).padStart(4, '0');
  return `${mm}:${ss}`;
}

function fmtNum(n: number | null | undefined, digits = 1, suffix = ''): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return n === -Infinity ? `-∞${suffix}` : n === Infinity ? `∞${suffix}` : '—';
  return `${n.toFixed(digits)}${suffix}`;
}

/**
 * Render every collected finding into one self-contained (no external CSS/
 * JS/fonts) dark-themed HTML report. Rows carry `data-tl="<seconds>"` when a
 * timeline time is known — deliberately with no click handler wired up
 * (click-to-seek is later web-integration work); the attribute is the only
 * hook a future script needs. Any of `staticReport`/`probe`/`tempo` may be
 * omitted (e.g. a QC pass run before an actual render exists has no `probe`
 * yet) — omitted sections simply don't render.
 */
export function buildQcReport(input: QcReportInput): string {
  const title = input.title ?? 'QC Report';
  const generatedAt = input.generatedAt ?? new Date().toISOString();

  type Row = { severity: QcSeverity; category: string; message: string; tl?: number };
  const rows: Row[] = [
    ...(input.staticReport?.issues ?? []).map((i): Row => ({ severity: i.severity, category: i.category, message: i.message, tl: i.tlTime })),
    ...(input.probe?.issues ?? []).map((i): Row => ({ severity: i.severity, category: i.kind, message: i.message, tl: i.t0 })),
  ].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || (a.tl ?? -1) - (b.tl ?? -1));

  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const r of rows) {
    if (r.severity === 'error') counts.errors++;
    else if (r.severity === 'warning') counts.warnings++;
    else counts.infos++;
  }

  const rowsHtml = rows.length
    ? rows
        .map(
          (r) => `      <tr class="sev-${r.severity}"${r.tl !== undefined ? ` data-tl="${r.tl}"` : ''}>
        <td class="sev">${sevLabel(r.severity)}</td>
        <td class="cat">${escapeHtml(r.category)}</td>
        <td class="msg">${escapeHtml(r.message)}</td>
        <td class="tl">${escapeHtml(fmtTl(r.tl))}</td>
      </tr>`,
        )
        .join('\n')
    : `      <tr><td colspan="4" class="empty">検出された問題はありません</td></tr>`;

  const probe = input.probe;
  const loudnessSection = probe
    ? `
    <section class="panel">
      <h2>Loudness / Audio (実測)</h2>
      <div class="stat-grid">
        <div class="stat"><span class="k">Integrated</span><span class="v">${fmtNum(probe.loudness.integratedLufs, 1, ' LUFS')}</span></div>
        <div class="stat"><span class="k">True Peak</span><span class="v">${fmtNum(probe.loudness.truePeakDb, 1, ' dBFS')}</span></div>
        <div class="stat"><span class="k">Loudness Range</span><span class="v">${fmtNum(probe.loudness.loudnessRangeLu, 1, ' LU')}</span></div>
        <div class="stat"><span class="k">Sample Peak</span><span class="v">${fmtNum(probe.audio.peakDb, 1, ' dB')}</span></div>
        <div class="stat"><span class="k">RMS</span><span class="v">${fmtNum(probe.audio.rmsDb, 1, ' dB')}</span></div>
        <div class="stat"><span class="k">Peak Count</span><span class="v">${probe.audio.peakCount ?? '—'}</span></div>
      </div>
      <details>
        <summary>検出された暗転(${probe.black.length}件)・無音(${probe.silence.length}件)の全リスト</summary>
        <ul class="raw-list">
${probe.black.map((b) => `          <li data-tl="${b.start}">black ${b.start.toFixed(1)}s-${b.end.toFixed(1)}s (${b.duration.toFixed(1)}s)</li>`).join('\n')}
${probe.silence.map((s) => `          <li data-tl="${s.start}">silence ${s.start.toFixed(1)}s${s.end !== null ? `-${s.end.toFixed(1)}s` : '〜末尾'}</li>`).join('\n')}
        </ul>
      </details>
    </section>`
    : '';

  const tempo = input.tempo;
  const tempoSection = tempo
    ? `
    <section class="panel">
      <h2>Tempo Contract (表示のみ・合否判定なし)</h2>
      <div class="stat-grid">
        <div class="stat"><span class="k">Shots</span><span class="v">${tempo.shotLengths?.count ?? '—'}</span></div>
        <div class="stat"><span class="k">Mean shot</span><span class="v">${fmtNum(tempo.shotLengths?.meanSeconds, 2, 's')}</span></div>
        <div class="stat"><span class="k">Median shot</span><span class="v">${fmtNum(tempo.shotLengths?.medianSeconds, 2, 's')}</span></div>
        <div class="stat"><span class="k">Min / Max shot</span><span class="v">${fmtNum(tempo.shotLengths?.minSeconds, 2, 's')} / ${fmtNum(tempo.shotLengths?.maxSeconds, 2, 's')}</span></div>
        <div class="stat"><span class="k">Silence ratio</span><span class="v">${tempo.silenceRatio !== null ? `${(tempo.silenceRatio * 100).toFixed(1)}%` : '—'}</span></div>
        <div class="stat"><span class="k">Kit avg shot</span><span class="v">${fmtNum(tempo.kitAverageShotSeconds, 2, 's')}</span></div>
        <div class="stat"><span class="k">Δ vs kit</span><span class="v">${tempo.deltaSeconds !== null ? `${tempo.deltaSeconds >= 0 ? '+' : ''}${tempo.deltaSeconds.toFixed(2)}s (${tempo.deltaPercent!.toFixed(1)}%)` : '—'}</span></div>
      </div>
    </section>`
    : '';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px;
    background: #0b0d10; color: #e6e6e6;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Segoe UI", sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { color: #8a8f98; font-size: 12px; margin-bottom: 20px; }
  .summary { display: flex; gap: 12px; margin-bottom: 20px; }
  .badge { padding: 8px 14px; border-radius: 8px; font-weight: 600; font-size: 13px; background: #14171c; border: 1px solid #262b33; }
  .badge.errors { color: #ff6b6b; }
  .badge.warnings { color: #ffb454; }
  .badge.infos { color: #6bb8ff; }
  table { width: 100%; border-collapse: collapse; background: #12151a; border: 1px solid #262b33; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #1d2129; font-size: 13px; }
  th { background: #14171c; color: #8a8f98; font-weight: 600; text-transform: uppercase; font-size: 11px; letter-spacing: 0.04em; }
  tr:last-child td { border-bottom: none; }
  td.sev { font-weight: 700; width: 70px; }
  tr.sev-error td.sev { color: #ff6b6b; }
  tr.sev-warning td.sev { color: #ffb454; }
  tr.sev-info td.sev { color: #6bb8ff; }
  td.cat { color: #8a8f98; width: 140px; white-space: nowrap; }
  td.tl { font-variant-numeric: tabular-nums; color: #8a8f98; width: 90px; }
  td.empty { text-align: center; color: #5f6570; padding: 24px; }
  section.panel { margin-top: 24px; }
  section.panel h2 { font-size: 15px; margin: 0 0 10px; color: #c7cbd1; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; }
  .stat { background: #12151a; border: 1px solid #262b33; border-radius: 8px; padding: 10px 12px; }
  .stat .k { display: block; color: #8a8f98; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .v { display: block; font-size: 16px; font-variant-numeric: tabular-nums; margin-top: 2px; }
  details { margin-top: 14px; }
  summary { cursor: pointer; color: #8a8f98; font-size: 12px; }
  ul.raw-list { list-style: none; margin: 10px 0 0; padding: 0; max-height: 220px; overflow-y: auto; font-size: 12px; font-variant-numeric: tabular-nums; color: #a8adb6; }
  ul.raw-list li { padding: 4px 8px; border-bottom: 1px solid #1a1d23; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">generated ${escapeHtml(generatedAt)}</div>
  <div class="summary">
    <div class="badge errors">${counts.errors} errors</div>
    <div class="badge warnings">${counts.warnings} warnings</div>
    <div class="badge infos">${counts.infos} infos</div>
  </div>
  <table>
    <thead>
      <tr><th>Severity</th><th>Category</th><th>Message</th><th>TL</th></tr>
    </thead>
    <tbody>
${rowsHtml}
    </tbody>
  </table>${loudnessSection}${tempoSection}
</body>
</html>
`;
}
