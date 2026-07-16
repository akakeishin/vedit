import { keptWords, sourceTimeToTimeline } from './ops.js';
import type { Manifest, Transcript } from './types.js';

export interface CaptionCue {
  tlStart: number;
  tlEnd: number;
  text: string;
  wordIds: string[];
}

const isCjk = (s: string) => /[぀-ヿ㐀-䶿一-鿿]/u.test(s);

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
        cues.push({
          tlStart,
          tlEnd: Math.max(tlEnd + (last.t1 - last.t0) / 2 + 0.15, tlStart + 0.6),
          text: buf.map((w) => w.text).join(join),
          wordIds: buf.map((w) => w.id),
        });
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
  return cues.sort((a, b) => a.tlStart - b.tlStart);
}
