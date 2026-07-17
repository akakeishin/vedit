import { keptWords, sourceTimeToTimeline, timelineDuration } from './ops.js';
import type { Manifest, Transcript } from './types.js';

export interface CaptionCue {
  tlStart: number;
  tlEnd: number;
  text: string;
  wordIds: string[];
  /**
   * Source id the cue's LEADING word (wordIds[0]) came from. Always set by
   * captionCues; declared optional only so hand-built test fixtures
   * elsewhere (e.g. qc.test.ts's `cue()` helper) don't need to supply it.
   */
  sourceId?: string;
  /**
   * `${sourceId}:${wordIds[0]}` (see captionCueKey) — a stable identity for
   * this cue, used to address it via Manifest.captionTextOverrides and by
   * the web UI's inline text-edit / caption style popover. Always set by
   * captionCues.
   */
  key?: string;
  /**
   * Present only when `text` was replaced by a Manifest.captionTextOverrides
   * entry — the original (sanitized) transcript text, shown by the web UI's
   * "✎修正済み" marker on hover.
   */
  originalText?: string;
}

/** `${sourceId}:${wordId}` — the Manifest.captionTextOverrides key format. */
export function captionCueKey(sourceId: string, wordId: string): string {
  return `${sourceId}:${wordId}`;
}

const isCjk = (s: string) => /[぀-ヿ㐀-䶿一-鿿]/u.test(s);

const BRACKET_PAIRS: [string, string][] = [
  ['(', ')'],
  ['（', '）'],
  ['「', '」'],
  ['『', '』'],
  ['[', ']'],
  ['【', '】'],
];

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/**
 * Whisper transcripts occasionally carry stray/unmatched bracket characters
 * (a cut-off aside, a mis-heard stage direction) and doubled-up whitespace
 * from word joins. Strip both so captions read clean.
 */
export function sanitizeCaptionText(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  for (const [open, close] of BRACKET_PAIRS) {
    if (countChar(t, open) !== countChar(t, close)) {
      t = t.split(open).join('').split(close).join('');
    }
  }
  return t;
}

/** Merge two chronologically-adjacent cues into one (used by the CPS floor below). */
function mergeCues(a: CaptionCue, b: CaptionCue): CaptionCue {
  const join = isCjk(a.text) || isCjk(b.text) ? '' : ' ';
  return {
    tlStart: Math.min(a.tlStart, b.tlStart),
    tlEnd: Math.max(a.tlEnd, b.tlEnd),
    text: sanitizeCaptionText(a.text + join + b.text),
    wordIds: [...a.wordIds, ...b.wordIds],
    // `a` is always the chronologically-earlier cue at every mergeCues call
    // site below, and wordIds[0] (used to build the merged cue's key) comes
    // from `a.wordIds` — so the merged cue's identity/source stays `a`'s.
    sourceId: a.sourceId,
  };
}

const MIN_DISPLAY = 0.6;
const DEFAULT_MAX_CPS = 8;

/**
 * Guarantee every cue is on screen long enough to read: at least
 * `text.length / maxCps` seconds (floor MIN_DISPLAY). A cue that's too short
 * — typically because de-overlap above just truncated it against a cue that
 * starts right after it — first tries to (a) borrow the idle gap before the
 * next cue (or the timeline end); if that's not enough, (b) merges into the
 * previous cue; if there is no previous cue, (c) merges into the next one
 * instead. Merging re-checks the combined cue against its own requirement,
 * so a chain of too-short cues collapses until it reads comfortably (or only
 * one cue is left, in which case it's kept as-is).
 */
function enforceMinDisplay(cues: CaptionCue[], total: number, maxCps: number): void {
  let i = 0;
  while (i < cues.length) {
    const c = cues[i];
    const need = Math.max(MIN_DISPLAY, c.text.length / maxCps);
    let dur = c.tlEnd - c.tlStart;
    if (dur >= need - 1e-9) {
      i++;
      continue;
    }

    // (a) borrow from the idle gap before the next cue (or the timeline end)
    const nextStart = i + 1 < cues.length ? cues[i + 1].tlStart : total;
    const gap = Math.max(0, nextStart - c.tlEnd);
    const borrow = Math.min(gap, need - dur);
    if (borrow > 0) {
      c.tlEnd += borrow;
      dur += borrow;
    }
    if (dur >= need - 1e-9) {
      i++;
      continue;
    }

    // (b) merge with the previous cue
    if (i > 0) {
      cues[i - 1] = mergeCues(cues[i - 1], c);
      cues.splice(i, 1);
      i--; // re-check the merged cue against its own requirement
      continue;
    }

    // (c) no previous cue (this is the first one) — merge with the next
    if (i + 1 < cues.length) {
      cues[i] = mergeCues(c, cues[i + 1]);
      cues.splice(i + 1, 1);
      continue; // re-check the merged cue at the same index
    }

    // only cue left in the whole list — nothing to merge with, keep as-is
    i++;
  }
}

/**
 * Derive caption cues from the kept words, in timeline time. Lines break on
 * pauses (>0.6s), sentence punctuation, or maxChars. Captions therefore follow
 * cuts automatically — there is no separately stored cue list to drift.
 */
export function captionCues(m: Manifest, transcripts: Transcript[]): CaptionCue[] {
  if (!m.captions.enabled) return [];
  const cues: CaptionCue[] = [];
  for (const t of transcripts) {
    const words = keptWords(m, t.sourceId, t.words);
    let buf: typeof words = [];
    const flush = () => {
      if (buf.length === 0) return;
      const tlStart = sourceTimeToTimeline(m, t.sourceId, (buf[0].t0 + buf[0].t1) / 2);
      const last = buf[buf.length - 1];
      const tlEnd = sourceTimeToTimeline(m, t.sourceId, (last.t0 + last.t1) / 2);
      if (tlStart !== null && tlEnd !== null) {
        const join = buf.some((w) => isCjk(w.text)) ? '' : ' ';
        const text = sanitizeCaptionText(buf.map((w) => w.text).join(join));
        if (text) {
          cues.push({
            tlStart,
            tlEnd: Math.max(tlEnd + (last.t1 - last.t0) / 2 + 0.15, tlStart + 0.6),
            text,
            wordIds: buf.map((w) => w.id),
            sourceId: t.sourceId,
          });
        }
      }
      buf = [];
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const prev = buf[buf.length - 1];
      const lineLen = buf.reduce((a, x) => a + x.text.length, 0);
      if (prev && (w.t0 - prev.t1 > 0.6 || lineLen + w.text.length > m.captions.maxChars)) flush();
      buf.push(w);
      if (/[。．.!?！？]$/u.test(w.text)) flush();
    }
    flush();
  }
  cues.sort((a, b) => a.tlStart - b.tlStart);

  // Clamp to the timeline's actual length and de-overlap adjacent cues —
  // both can happen at a source's tail where word timestamps run slightly
  // past the last kept segment.
  const total = timelineDuration(m);
  for (const c of cues) if (c.tlEnd > total) c.tlEnd = total;
  for (let i = 0; i < cues.length - 1; i++) {
    if (cues[i].tlEnd > cues[i + 1].tlStart) cues[i].tlEnd = cues[i + 1].tlStart;
  }

  // De-overlap above can truncate a cue well below a readable duration (a
  // sentence flushed at 0.6s can get cut down to ~100ms if the next cue
  // starts right after) — restore a minimum display time by borrowing idle
  // time or merging with a neighbor.
  enforceMinDisplay(cues, total, m.captions.maxCps ?? DEFAULT_MAX_CPS);

  // W-CAP: apply per-cue text corrections last, once every cue's final
  // (post-merge, post-de-overlap) leading word is known — each cue's key is
  // `${sourceId}:${wordIds[0]}` (captionCueKey). An override of '' hides
  // the cue entirely (filtered out below, same as the existing
  // tlEnd>tlStart guard); absent from captionTextOverrides -> unaffected.
  const textOverrides = m.captionTextOverrides ?? {};
  const out: CaptionCue[] = [];
  for (const c of cues) {
    if (c.tlEnd <= c.tlStart) continue;
    const key = c.sourceId !== undefined && c.wordIds.length > 0 ? captionCueKey(c.sourceId, c.wordIds[0]) : undefined;
    const override = key !== undefined && Object.prototype.hasOwnProperty.call(textOverrides, key) ? textOverrides[key] : undefined;
    if (override === undefined) {
      out.push({ ...c, key });
    } else if (override !== '') {
      out.push({ ...c, key, text: override, originalText: c.text });
    } // override === '' -> cue hidden entirely
  }
  return out;
}
