import { segments, timelineDuration } from './ops.js';
import type { Manifest, Transcript, Word } from './types.js';

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

// ---- P1: non-speech-tag cue exclusion ----
//
// Whisper occasionally hallucinates a closed-caption-style annotation for
// non-speech audio (crowd/street noise, an ambient music bed) instead of
// transcribing nothing — e.g. a noisy street becomes the transcript word(s)
// "[MÚSICA DE FUNDO]" ("[BACKGROUND MUSIC]" in Portuguese). Left alone, cue
// generation happily turns that into a timed subtitle that gets burned into
// the final render. isNonSpeechAnnotation below checks a cue's FULL text
// only — never a substring — so a cue mixing a bracketed aside with real
// spoken words (e.g. "そう思う(拍手)") is always kept as-is.

const NOTE_SYMBOLS_RE = /[♪♫♬♩]/gu;

/** Bracket styles this feature treats as a possible non-speech-tag wrapper. Deliberately a subset of BRACKET_PAIRS above — quote-style pairs (「」『』) are excluded since they wrap actual quoted speech, not annotations. */
const ANNOTATION_BRACKET_PAIRS: [string, string][] = [
  ['(', ')'],
  ['[', ']'],
  ['【', '】'],
];

/**
 * Multilingual vocabulary of non-speech annotation words Whisper is known to
 * hallucinate — music, applause, laughter, silence/no-audio, generic noise —
 * across a handful of languages. Deliberately bounded to these categories;
 * not an attempt at an exhaustive sound-effect vocabulary (staying
 * conservative per the "whole cue only" rule below matters more than
 * covering every possible tag).
 */
const NON_SPEECH_PHRASES = new Set([
  // English
  'music', 'background music', 'music playing', 'instrumental music',
  'applause', 'clapping', 'laughter', 'laughing',
  'silence', 'no audio', 'blank audio', 'inaudible', 'unintelligible',
  'noise', 'background noise', 'static', 'static noise',
  // Spanish
  'música', 'musica', 'música de fondo', 'musica de fondo',
  'aplausos', 'risas', 'risa', 'silencio', 'ruido',
  // Portuguese
  'música de fundo', 'musica de fundo', 'aplausos', 'risadas',
  'silêncio', 'silencio', 'ruído', 'ruido',
  // German
  'musik', 'hintergrundmusik', 'applaus', 'gelächter', 'lachen', 'stille', 'rauschen',
  // French
  'musique', 'musique de fond', 'applaudissements', 'rires', 'rire', 'silence', 'bruit de fond', 'bruit',
  // Italian
  'musica', 'musica di sottofondo', 'applausi', 'risate', 'risata', 'silenzio', 'rumore',
  // Japanese
  '音楽', 'bgm', '拍手', '笑い', '笑い声', '無音', '沈黙', '雑音',
  // Chinese
  '音乐', '鼓掌', '笑声', '静音', '噪音',
  // Korean
  '음악', '박수', '웃음', '정적', '소음',
]);

/** `"[foo]" -> "foo"`, `"(foo)" -> "foo"`, `"【foo】" -> "foo"`; `null` when `s` isn't fully wrapped by one of ANNOTATION_BRACKET_PAIRS start-to-end. */
function stripOuterAnnotationBrackets(s: string): string | null {
  for (const [open, close] of ANNOTATION_BRACKET_PAIRS) {
    if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length) {
      return s.slice(open.length, s.length - close.length);
    }
  }
  return null;
}

/**
 * True when `text` (a single cue's FULL, already-sanitized text) is nothing
 * but a Whisper-hallucinated non-speech annotation — a bracketed tag like
 * "[MÚSICA DE FUNDO]" / "[Music]" / "(Applause)" / "【音楽】", or a bare run
 * of musical-note symbols ("♪♪♪") — rather than real transcribed speech.
 *
 * Whole-cue-only by construction: a cue that mixes a bracketed aside with
 * real spoken words never reaches the "consists ONLY of tag vocabulary"
 * check below, because splitting the aside out of it isn't this function's
 * job — the caller (captionCuesWithExclusions) only ever calls this with a
 * cue's complete text.
 */
export function isNonSpeechAnnotation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  // A bare musical-note-symbol line ("♪", "♪ ♪ ♪") is hallucinated for
  // instrumental passages with no lyrics, independent of bracket wrapping.
  if (trimmed.replace(NOTE_SYMBOLS_RE, '').trim() === '') return true;

  const inner = stripOuterAnnotationBrackets(trimmed);
  if (inner === null) return false; // no full-cue bracket wrap -> never excluded

  const normalized = inner
    .replace(NOTE_SYMBOLS_RE, ' ')
    .replace(/[.,!?。、！？・]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return true; // e.g. "[...]" / "[♪]" — bracketed but empty of words
  return NON_SPEECH_PHRASES.has(normalized);
}

/** A cue dropped by captionCuesWithExclusions because isNonSpeechAnnotation(text) was true. */
export interface NonSpeechExclusion {
  /** The excluded cue's full (sanitized, pre-override) text, e.g. "[MÚSICA DE FUNDO]". */
  text: string;
}

/**
 * Format a transparency warning for cues dropped by isNonSpeechAnnotation —
 * used by renderFinal (render.ts) and the CLI srt export (srt.ts) so a
 * hallucinated non-speech tag never silently vanishes without a trace. Shows
 * up to 3 example texts; any remainder is summarized as "他N件".
 */
export function formatCaptionExclusionWarning(excluded: NonSpeechExclusion[]): string {
  const shown = excluded.slice(0, 3).map((e) => e.text);
  const more = excluded.length - shown.length;
  return `非発話タグを字幕から除外(${excluded.length}件: ${shown.join('、')}${more > 0 ? ` 他${more}件` : ''})`;
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
 *
 * P1: a cue whose entire text is a non-speech annotation (Whisper
 * hallucination — see isNonSpeechAnnotation) is silently dropped, exactly
 * like the existing "sanitizes down to nothing" case below. Callers that
 * need to report the drop (a transparency warning) use
 * captionCuesWithExclusions instead — this function just discards it.
 */
export function captionCues(m: Manifest, transcripts: Transcript[]): CaptionCue[] {
  return captionCuesWithExclusions(m, transcripts).cues;
}

/**
 * Same derivation as captionCues, but also reports cues DROPPED because
 * their full (post-override) text is a non-speech annotation
 * (isNonSpeechAnnotation) — used by renderFinal and the CLI srt export to
 * surface a transparency warning ("非発話タグを字幕から除外(...)"). The raw
 * transcript itself is never touched by this — only cue GENERATION is
 * affected, so the words are still visible/editable wherever transcripts
 * are shown directly.
 */
export function captionCuesWithExclusions(
  m: Manifest,
  transcripts: Transcript[],
): { cues: CaptionCue[]; excluded: NonSpeechExclusion[] } {
  if (!m.captions.enabled) return { cues: [], excluded: [] };
  const cues: CaptionCue[] = [];
  const allSegments = segments(m);
  for (const t of transcripts) {
    // Placement-aware word mapping (fixes: the same source placed twice on
    // the timeline only ever got cues for its FIRST placement). Rather than
    // filtering the transcript once per source (keptWords) and mapping each
    // surviving word's time via sourceTimeToTimeline — which always resolves
    // to whichever placement's Segment comes first, no matter how many
    // placements a word's source-time actually falls inside — this walks
    // this source's Segments directly (one per timeline placement, in
    // timeline order) and re-derives each word's timeline time from the
    // SPECIFIC segment it was found in. A word whose source time falls
    // inside two placements is therefore visited twice, once per placement,
    // each producing its own buffered cue.
    const segsForSource = allSegments.filter((s) => s.sourceId === t.sourceId);
    type BufWord = { word: Word; tl0: number; tl1: number };
    let buf: BufWord[] = [];
    const flush = () => {
      if (buf.length === 0) return;
      const first = buf[0];
      const last = buf[buf.length - 1];
      // Matches the pre-fix arithmetic exactly (tlStart from the FIRST
      // word's midpoint, tlEnd from the LAST word's end + 0.15s padding,
      // floored at a 0.6s minimum) — only the source of tl0/tl1 changed
      // (now per-segment, not a global sourceTimeToTimeline lookup).
      const tlStart = (first.tl0 + first.tl1) / 2;
      const tlEnd = Math.max(last.tl1 + 0.15, tlStart + 0.6);
      const join = buf.some((x) => isCjk(x.word.text)) ? '' : ' ';
      const text = sanitizeCaptionText(buf.map((x) => x.word.text).join(join));
      if (text) {
        cues.push({ tlStart, tlEnd, text, wordIds: buf.map((x) => x.word.id), sourceId: t.sourceId });
      }
      buf = [];
    };
    for (const seg of segsForSource) {
      const segDur = seg.tlEnd - seg.tlStart;
      for (const w of t.words) {
        const mid = (w.t0 + w.t1) / 2;
        if (mid < seg.srcStart || mid >= seg.srcStart + segDur) continue;
        const tl0 = seg.tlStart + (w.t0 - seg.srcStart);
        const tl1 = seg.tlStart + (w.t1 - seg.srcStart);
        const prev = buf[buf.length - 1];
        const lineLen = buf.reduce((a, x) => a + x.word.text.length, 0);
        // Gap/line-length flush, unchanged in spirit from before: the gap
        // check now compares TIMELINE time (tl0 - prev.tl1) rather than raw
        // source time. Within one segment these are numerically identical
        // (a fixed per-segment offset cancels out of the subtraction), so
        // every existing single-placement test is unaffected; across a
        // segment boundary this is what lets a ripple-cut mid-sentence
        // (two adjacent segments from the same original placement) still
        // read as one continuous cue, while two genuinely distant
        // placements of the same source correctly start a fresh cue.
        if (prev && (tl0 - prev.tl1 > 0.6 || lineLen + w.text.length > m.captions.maxChars)) flush();
        buf.push({ word: w, tl0, tl1 });
        if (/[。．.!?！？]$/u.test(w.text)) flush();
      }
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
  const excluded: NonSpeechExclusion[] = [];
  for (const c of cues) {
    if (c.tlEnd <= c.tlStart) continue;
    const key = c.sourceId !== undefined && c.wordIds.length > 0 ? captionCueKey(c.sourceId, c.wordIds[0]) : undefined;
    const override = key !== undefined && Object.prototype.hasOwnProperty.call(textOverrides, key) ? textOverrides[key] : undefined;
    if (override === undefined) {
      // P1: the non-speech-tag filter only ever looks at a cue's UNedited
      // text — a manual text correction (an editor who already fixed a
      // hallucinated cue) always wins and is never silently discarded here.
      if (isNonSpeechAnnotation(c.text)) {
        excluded.push({ text: c.text });
        continue;
      }
      out.push({ ...c, key });
    } else if (override !== '') {
      out.push({ ...c, key, text: override, originalText: c.text });
    } // override === '' -> cue hidden entirely
  }
  return { cues: out, excluded };
}
