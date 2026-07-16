import { freshId } from './ops.js';
import type { CutCandidate, Transcript } from './types.js';

const FILLERS_JA = ['えー', 'えーと', 'えっと', 'あのー', 'あの', 'まあ', 'なんか', 'その', 'こう'];
const FILLERS_EN = ['um', 'uh', 'like', 'you know', 'so', 'actually', 'basically'];

/** Gaps between words longer than `minGap` seconds become silence candidates. */
export function detectSilences(t: Transcript, minGap = 0.7, pad = 0.12): CutCandidate[] {
  const out: CutCandidate[] = [];
  const w = t.words;
  for (let i = 0; i < w.length - 1; i++) {
    const gap = w[i + 1].t0 - w[i].t1;
    if (gap >= minGap) {
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
  if (w.length > 0 && w[0].t0 >= minGap) {
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
