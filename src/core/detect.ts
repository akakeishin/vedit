import { freshId } from './ops.js';
import type { CutCandidate, Transcript, Word } from './types.js';

const FILLERS_JA = ['えー', 'えーと', 'えっと', 'あのー', 'あの', 'まあ', 'なんか', 'その', 'こう'];
const FILLERS_EN = ['um', 'uh', 'like', 'you know', 'so', 'actually', 'basically'];
// Words that are plausibly real content, not just filler — require a
// stricter flanking pause before trusting they were used as a filler.
const AMBIGUOUS_FILLERS = new Set(['so', 'like', 'その', 'まあ']);
const STRICT_FLANK_GAP = 0.25;

const isCjk = (s: string) => /[぀-ヿ㐀-䶿一-鿿]/u.test(s);

/** NFKC-normalize (full-width→half-width, compatibility forms) before matching against the filler dictionary. */
function normalizeFillerToken(s: string): string {
  return s.normalize('NFKC').trim().toLowerCase().replace(/[、。,.!?]+$/u, '');
}

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

/**
 * Standalone filler words/phrases (conservative: only when flanked by
 * pauses). Matches 1-to-3-token n-grams against the dictionary (after NFKC
 * normalization) so a filler whisper splits across tokens — "えー" + "と" →
 * "えーと" — or a space-delimited multi-word filler like "you know" still
 * matches; longer n-grams are preferred over a shorter sub-match. Words that
 * could plausibly be real content ("so", "like", "その", "まあ") require a
 * stricter flanking-pause gap before being trusted as fillers.
 */
export function detectFillers(t: Transcript, minFlankGap = 0.15): CutCandidate[] {
  const fillerSet = new Set([...FILLERS_JA, ...FILLERS_EN].map(normalizeFillerToken));
  const ambiguous = new Set([...AMBIGUOUS_FILLERS].map(normalizeFillerToken));
  const out: CutCandidate[] = [];
  const w = t.words;
  const consumed = new Set<number>();

  for (let i = 0; i < w.length; i++) {
    if (consumed.has(i)) continue;

    let matchLen = 0;
    let matchedNorm = '';
    for (let n = Math.min(3, w.length - i); n >= 1; n--) {
      const slice = w.slice(i, i + n);
      const noSpace = normalizeFillerToken(slice.map((x) => x.text).join(''));
      const spaced = normalizeFillerToken(slice.map((x) => x.text).join(' '));
      if (fillerSet.has(noSpace)) {
        matchLen = n;
        matchedNorm = noSpace;
        break;
      }
      if (fillerSet.has(spaced)) {
        matchLen = n;
        matchedNorm = spaced;
        break;
      }
    }
    if (matchLen === 0) continue;

    const startIdx = i;
    const endIdx = i + matchLen - 1;
    const before = startIdx === 0 ? Infinity : w[startIdx].t0 - w[startIdx - 1].t1;
    const after = endIdx === w.length - 1 ? Infinity : w[endIdx + 1].t0 - w[endIdx].t1;
    const isAmbiguous = matchLen === 1 && ambiguous.has(matchedNorm);
    const requiredGap = isAmbiguous ? STRICT_FLANK_GAP : minFlankGap;
    if (before < requiredGap && after < requiredGap) continue; // mid-sentence, keep

    const slice = w.slice(startIdx, endIdx + 1);
    const displayText = slice.some((x) => isCjk(x.text)) ? slice.map((x) => x.text).join('') : slice.map((x) => x.text).join(' ');
    out.push({
      id: freshId('cand'),
      kind: 'filler',
      sourceId: t.sourceId,
      t0: w[startIdx].t0,
      t1: w[endIdx].t1,
      wordIds: slice.map((x) => x.id),
      label: `filler "${displayText}"`,
      status: 'proposed',
    });
    for (let k = startIdx; k <= endIdx; k++) consumed.add(k);
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
  opts: {
    sourceId: string;
    threshold?: number;
    minGap?: number;
    pad?: number;
    words?: Word[];
    /** Speech runs shorter than this are noise (click/pop/breath), merged back into the surrounding silence. Default 0.08s. */
    minSpeechLen?: number;
    /** Exit threshold = threshold * exitMultiplier; must be > 1 for hysteresis to have any effect. Default 1.4. */
    exitMultiplier?: number;
  },
): CutCandidate[] {
  const enter = opts.threshold ?? adaptiveThreshold(peaks.peaks);
  const exit = enter * (opts.exitMultiplier ?? 1.4);
  const minSpeechLen = opts.minSpeechLen ?? 0.08;
  const packed = opts.words ? timestampsArePacked(opts.words) : false;
  const minGap = opts.minGap ?? 0.7;
  const pad = opts.pad ?? 0.12;
  const rate = peaks.rate;
  const out: CutCandidate[] = [];

  // Pass 1 — hysteresis: dropping below `enter` starts a silence run, but
  // only rising above the higher `exit` ends it. A single-sample peak that
  // clears `enter` but not `exit` therefore can't fragment an otherwise
  // continuous silence into two pieces that then both fail `minGap` and
  // vanish entirely (a real observed bug: a ~40ms peak inside a ~1s silence
  // deleted the whole candidate).
  const silent: boolean[] = new Array(peaks.peaks.length);
  let isSilent = peaks.peaks.length > 0 && peaks.peaks[0] < enter;
  for (let i = 0; i < peaks.peaks.length; i++) {
    const v = peaks.peaks[i];
    if (isSilent) {
      if (v >= exit) isSilent = false;
    } else if (v < enter) {
      isSilent = true;
    }
    silent[i] = isSilent;
  }

  // Pass 2 — minimum speech length: a "loud" run shorter than
  // `minSpeechLen` is noise, not real speech splitting the silence around
  // it; merge it back into silence so it doesn't cut one candidate into two
  // independently-too-short ones.
  const minSpeechSamples = Math.round(minSpeechLen * rate);
  let i = 0;
  while (i < silent.length) {
    if (!silent[i]) {
      let j = i;
      while (j < silent.length && !silent[j]) j++;
      if (j - i < minSpeechSamples) for (let k = i; k < j; k++) silent[k] = true;
      i = j;
    } else {
      i++;
    }
  }

  const emit = (startIdx: number, endIdx: number) => {
    let t0 = startIdx / rate;
    let t1 = endIdx / rate;
    const rawSpan = t1 - t0;
    if (rawSpan < minGap) return;
    // conflict: transcript claims speech inside a physically quiet window
    // (soft laughter, whispered asides, fabricated word boundaries). Strong
    // waveform evidence still surfaces the candidate — flagged for preview —
    // instead of being silently vetoed; the approve queue exists for exactly
    // this ambiguity.
    let conflict = packed;
    if (opts.words && opts.words.length && !packed) {
      const clamped = clampToWordBoundaries(t0, t1, opts.words);
      if (clamped && clamped.t1 - clamped.t0 >= minGap) {
        t0 = clamped.t0;
        t1 = clamped.t1;
      } else if (rawSpan >= minGap * 1.5) {
        conflict = true; // keep the raw window, but demand a preview
      } else {
        return;
      }
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
      label: `${(t1 - t0).toFixed(1)}s silence (waveform${conflict ? '; transcript disagrees — preview before approving' : ''})`,
      status: 'proposed',
    });
  };

  let runStart: number | null = null;
  for (let k = 0; k < silent.length; k++) {
    if (silent[k] && runStart === null) runStart = k;
    if (!silent[k] && runStart !== null) {
      emit(runStart, k);
      runStart = null;
    }
  }
  if (runStart !== null) emit(runStart, silent.length);
  return out;
}
