import { keptWords, segments } from './ops.js';
import type { CutCandidate, Manifest, Transcript } from './types.js';

function ts(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

/**
 * Packed transcript: the compact text view Claude reads instead of raw JSON.
 * One paragraph block per stretch of speech; every word carries an id only at
 * block edges + every Nth word so ranges can be addressed without exploding
 * token count. Cut-away words are omitted; pauses and candidates annotated.
 */
export function packTranscript(
  m: Manifest,
  t: Transcript,
  candidates: CutCandidate[] = [],
  idEvery = 8,
): string {
  const words = keptWords(m, t.sourceId, t.words);
  if (words.length === 0) return '(no speech on the timeline for this source)';
  const candByWord = new Map<string, CutCandidate>();
  for (const c of candidates) for (const id of c.wordIds) candByWord.set(id, c);

  const lines: string[] = [];
  let buf: string[] = [];
  let blockStart = words[0];

  const flush = (last: (typeof words)[number]) => {
    if (buf.length === 0) return;
    lines.push(`[${ts(blockStart.t0)}–${ts(last.t1)}] ${buf.join(' ')}`);
    buf = [];
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const prev = words[i - 1];
    if (prev) {
      const gap = w.t0 - prev.t1;
      if (gap >= 0.7) {
        flush(prev);
        lines.push(`  (${gap.toFixed(1)}s pause)`);
        blockStart = w;
      }
    }
    const cand = candByWord.get(w.id);
    const flagged = w.p < 0.4 || (cand && cand.status === 'proposed');
    const tagId = i % idEvery === 0 || i === words.length - 1 || buf.length === 0 || flagged;
    let token = tagId ? `${w.text}⟨${w.id}⟩` : w.text;
    if (w.p < 0.4) token += '?';
    if (cand && cand.status === 'proposed') token += `[${cand.kind}]`;
    buf.push(token);
  }
  flush(words[words.length - 1]);

  const dur = segments(m).reduce((a, s) => a + s.tlEnd - s.tlStart, 0);
  const header = [
    `# packed transcript (source ${t.sourceId}, timeline ${ts(dur)} total, ${words.length} words kept)`,
    `# times are SOURCE time; ⟨id⟩ marks word ids; use ranges like ${words[0].id}..${words[Math.min(10, words.length - 1)].id}`,
    `# "?"=low confidence, [silence]/[filler]=pending candidates`,
    '# need every id? run `vedit transcript --full --source <id>`',
  ];
  return [...header, ...lines].join('\n');
}
