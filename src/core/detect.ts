import { freshId } from './ops.js';
import type { CutCandidate, Transcript, Word } from './types.js';

const FILLERS_JA = ['えー', 'えーと', 'えっと', 'あのー', 'あの', 'まあ', 'なんか', 'その', 'こう'];
const FILLERS_EN = ['um', 'uh', 'like', 'you know', 'so', 'actually', 'basically'];

/** Gaps between words longer than `minGap` seconds become silence candidates. */
export function detectSilences(t: Transcript, minGap = 0.7, pad = 0.12): CutCandidate[] {
  const out: CutCandidate[] = [];
  const w = t.words;
  for (let i = 0; i < w.length - 1; i++) {
    const gap = w[i + 1].t0 - w[i].t1;
    // padding must not invert the range (short gaps just above minGap)
    if (gap >= minGap && gap > pad * 2) {
      out.push({
        id: freshId('cand'),
        kind: 'silence',
        sourceId: t.sourceId,
        t0: w[i].t1 + pad,
        t1: w[i + 1].t0 - pad,
        wordIds: [],
        label: `${gap.toFixed(1)}s silence after "${w[i].text}"`,
        status: 'proposed',
      });
    }
  }
  // Leading silence before the first word.
  if (w.length > 0 && w[0].t0 >= minGap && w[0].t0 > pad) {
    out.unshift({
      id: freshId('cand'),
      kind: 'silence',
      sourceId: t.sourceId,
      t0: 0,
      t1: w[0].t0 - pad,
      wordIds: [],
      label: `${w[0].t0.toFixed(1)}s leading silence`,
      status: 'proposed',
    });
  }
  return out;
}

/** Standalone filler words (conservative: exact match, only when flanked by pauses). */
export function detectFillers(t: Transcript, minFlankGap = 0.15): CutCandidate[] {
  const fillers = new Set([...FILLERS_JA, ...FILLERS_EN].map((f) => f.toLowerCase()));
  const out: CutCandidate[] = [];
  const w = t.words;
  for (let i = 0; i < w.length; i++) {
    const text = w[i].text.trim().toLowerCase().replace(/[、。,.!?]$/u, '');
    if (!fillers.has(text)) continue;
    const before = i === 0 ? Infinity : w[i].t0 - w[i - 1].t1;
    const after = i === w.length - 1 ? Infinity : w[i + 1].t0 - w[i].t1;
    if (before < minFlankGap && after < minFlankGap) continue; // mid-sentence, keep
    out.push({
      id: freshId('cand'),
      kind: 'filler',
      sourceId: t.sourceId,
      t0: w[i].t0,
      t1: w[i].t1,
      wordIds: [w[i].id],
      label: `filler "${w[i].text}"`,
      status: 'proposed',
    });
  }
  return out;
}

export interface Peaks {
  /** Samples per second. */
  rate: number;
  peaks: number[];
}

/**
 * Shrink [t0,t1] so it no longer overlaps any word with real duration.
 * Whisper packing words with no gap fools the word-gap detector, but the
 * waveform still shows the quiet stretch — this keeps that stretch from
 * eating into speech the transcript says is there. Returns null if a word
 * spans the whole window (i.e. it isn't silence after all).
 */
function clampToWordBoundaries(t0: number, t1: number, words: Word[]): { t0: number; t1: number } | null {
  let a = t0;
  let b = t1;
  for (const w of words) {
    if (w.t1 <= w.t0) continue; // zero-width word, ignore
    if (w.t1 <= a || w.t0 >= b) continue; // no overlap
    if (w.t0 <= a && w.t1 >= b) return null; // word covers the whole window
    if (w.t0 <= a) a = w.t1; // word overlaps the left edge
    else if (w.t1 >= b) b = w.t0; // word overlaps the right edge
    else {
      // word sits fully inside the window: keep whichever side is bigger
      if (w.t0 - a >= b - w.t1) b = w.t0;
      else a = w.t1;
    }
  }
  return a < b ? { t0: a, t1: b } : null;
}

/**
 * Waveform-based silence detection: a fallback for when whisper packs words
 * with no gap between them, so `detectSilences` (word-gap based) finds
 * nothing even though the audio is clearly quiet. Consumes the peaks JSON
 * written by `makePeaks` (rate samples/sec, 0..1 magnitude).
 */
/**
 * Pick a silence threshold from the source's own level distribution: quiet
 * outdoor footage (street ambience, low mic gain) never drops below a fixed
 * absolute floor, so "silence" has to mean "near this clip's noise floor".
 */
export function adaptiveThreshold(peaks: number[]): number {
  const s = [...peaks].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  const floor = q(0.1);
  const loud = q(0.9);
  return Math.min(0.12, Math.max(0.02, floor + 0.25 * (loud - floor)));
}

/**
 * Whisper sometimes emits words packed back-to-back (zero gap between every
 * pair) — timing fabricated by even spreading, not acoustics. Such transcripts
 * must not veto waveform silence candidates.
 */
export function timestampsArePacked(words: Word[], ratio = 0.8): boolean {
  let zero = 0;
  let total = 0;
  for (let i = 1; i < words.length; i++) {
    total++;
    if (words[i].t0 - words[i - 1].t1 <= 0.001) zero++;
  }
  return total >= 5 && zero / total >= ratio;
}

export function detectSilencesFromPeaks(
  peaks: Peaks,
  opts: { sourceId: string; threshold?: number; minGap?: number; pad?: number; words?: Word[] },
): CutCandidate[] {
  const threshold = opts.threshold ?? adaptiveThreshold(peaks.peaks);
  const packed = opts.words ? timestampsArePacked(opts.words) : false;
  const minGap = opts.minGap ?? 0.7;
  const pad = opts.pad ?? 0.12;
  const rate = peaks.rate;
  const out: CutCandidate[] = [];

  const emit = (startIdx: number, endIdx: number) => {
    let t0 = startIdx / rate;
    let t1 = endIdx / rate;
    if (t1 - t0 < minGap) return;
    if (opts.words && opts.words.length && !packed) {
      const clamped = clampToWordBoundaries(t0, t1, opts.words);
      if (!clamped || clamped.t1 - clamped.t0 < minGap) return;
      t0 = clamped.t0;
      t1 = clamped.t1;
    }
    const a = t0 + pad;
    const b = t1 - pad;
    if (b <= a) return;
    out.push({
      id: freshId('cand'),
      kind: 'silence',
      sourceId: opts.sourceId,
      t0: a,
      t1: b,
      wordIds: [],
      label: `${(t1 - t0).toFixed(1)}s silence (waveform${packed ? '; transcript timing unreliable — preview before approving' : ''})`,
      status: 'proposed',
    });
  };

  let runStart: number | null = null;
  for (let i = 0; i < peaks.peaks.length; i++) {
    const below = peaks.peaks[i] < threshold;
    if (below && runStart === null) runStart = i;
    if (!below && runStart !== null) {
      emit(runStart, i);
      runStart = null;
    }
  }
  if (runStart !== null) emit(runStart, peaks.peaks.length);
  return out;
}
