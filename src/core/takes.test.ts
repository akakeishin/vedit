import { describe, expect, it } from 'vitest';
import { LOW_CONFIDENCE_RECOMMEND_THRESHOLD, detectTakes, packTakes } from './takes.js';
import type { Transcript, Word } from './types.js';

// ---- fixture helpers ----
//
// Builds a run of Word tokens starting at `startT`, each `tokenDur` long with
// `innerGap` between them (well under detectTakes' default longPauseSeconds
// of 1.0s, so a single call never gets split into multiple utterances).

function mkWords(idPrefix: string, tokens: string[], startT: number, opts: { p?: number[]; tokenDur?: number; innerGap?: number } = {}): Word[] {
  const tokenDur = opts.tokenDur ?? 0.3;
  const innerGap = opts.innerGap ?? 0.03;
  let t = startT;
  return tokens.map((text, i) => {
    const t0 = t;
    const t1 = t0 + tokenDur;
    t = t1 + innerGap;
    return { id: `${idPrefix}${i}`, text, t0, t1, p: opts.p?.[i] ?? 0.9 };
  });
}

function endOf(words: Word[]): number {
  return words[words.length - 1].t1;
}

function mkTranscript(words: Word[]): Transcript {
  return { sourceId: 's1', language: 'ja', words };
}

// A real vlog line, re-recorded — the canonical scenario this module exists for.
const SHIBUYA = ['今日', 'は', '渋谷', 'に', '来ました'];
// A different sentence, unrelated to SHIBUYA (used for "must not group" checks).
const UNRELATED = ['明日', 'は', '晴れる', 'らしい', 'です'];

describe('detectTakes — grouping re-recorded takes of the same line', () => {
  it('groups three re-takes of "今日は渋谷に来ました" said 2.5s apart into one group, and recommends the (clean) last take', () => {
    const take1 = mkWords('t1w', SHIBUYA, 0);
    const take2 = mkWords('t2w', SHIBUYA, endOf(take1) + 2.5);
    const take3 = mkWords('t3w', SHIBUYA, endOf(take2) + 2.5);
    const transcript = mkTranscript([...take1, ...take2, ...take3]);

    const groups = detectTakes(transcript);
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.utterances).toHaveLength(3);
    // chronological order preserved
    expect(group.utterances.map((u) => u.wordIds[0])).toEqual(['t1w0', 't2w0', 't3w0']);
    expect(group.utterances.every((u) => u.text === '今日は渋谷に来ました')).toBe(true);
    // all three are clean (p=0.9 throughout) — last take should win outright
    expect(group.recommendation.utteranceIndex).toBe(2);
    expect(group.recommendation.reason).toContain('最後のテイク');
  });

  it('does not group a single, unrepeated utterance (no similar sibling anywhere) — "単発発話はグループ化されない"', () => {
    const take1 = mkWords('g1w', SHIBUYA, 0);
    const take2 = mkWords('g2w', SHIBUYA, endOf(take1) + 2.0);
    // Timed close to the pair (within the 30s window) but textually unrelated.
    const lone = mkWords('lonew', UNRELATED, endOf(take2) + 2.0);
    const transcript = mkTranscript([...take1, ...take2, ...lone]);

    const groups = detectTakes(transcript);
    expect(groups).toHaveLength(1);
    expect(groups[0].utterances).toHaveLength(2);
    const groupedIds = new Set(groups.flatMap((g) => g.utterances.flatMap((u) => u.wordIds)));
    for (const w of lone) expect(groupedIds.has(w.id)).toBe(false);
  });

  it('never merges take groups across the (default 30s) time window, even when the text is identical', () => {
    const early1 = mkWords('e1w', SHIBUYA, 0);
    const early2 = mkWords('e2w', SHIBUYA, endOf(early1) + 2.0);
    // > 30s after early2 — must not chain into the same group as early1/early2.
    const lateStart = endOf(early2) + 40;
    const late1 = mkWords('l1w', SHIBUYA, lateStart);
    const late2 = mkWords('l2w', SHIBUYA, endOf(late1) + 2.0);
    const transcript = mkTranscript([...early1, ...early2, ...late1, ...late2]);

    const groups = detectTakes(transcript);
    expect(groups).toHaveLength(2);
    expect(groups[0].utterances.map((u) => u.wordIds[0])).toEqual(['e1w0', 'e2w0']);
    expect(groups[1].utterances.map((u) => u.wordIds[0])).toEqual(['l1w0', 'l2w0']);
  });

  it('chains take groups transitively: A~B and B~C both clear simThreshold even though A~C alone falls short', () => {
    // Dice coefficients verified offline (character-bigram, NFKC-normalized):
    //   A vs B = 0.80, B vs C = 0.71, A vs C = 0.54 (< default 0.55 threshold)
    const A = '今日は渋谷に来ました';
    const B = '今日はマジ渋谷に来ました';
    const C = '今日はマジ渋谷にちょっとだけ来ました';
    const wa = mkWords('caw', [A], 0);
    const wb = mkWords('cbw', [B], endOf(wa) + 2.0);
    const wc = mkWords('ccw', [C], endOf(wb) + 2.0);
    const transcript = mkTranscript([...wa, ...wb, ...wc]);

    const groups = detectTakes(transcript);
    expect(groups).toHaveLength(1);
    expect(groups[0].utterances.map((u) => u.text)).toEqual([A, B, C]);
  });

  it('does not group two temporally-close utterances whose text similarity falls under the threshold', () => {
    const a = mkWords('uaw', SHIBUYA, 0);
    const b = mkWords('ubw', UNRELATED, endOf(a) + 2.0);
    const groups = detectTakes(mkTranscript([...a, ...b]));
    expect(groups).toHaveLength(0);
  });

  it('returns no groups for an empty transcript or a single utterance', () => {
    expect(detectTakes(mkTranscript([]))).toEqual([]);
    expect(detectTakes(mkTranscript(mkWords('onlyw', SHIBUYA, 0)))).toEqual([]);
  });
});

describe('detectTakes — recommendation rule ("last take wins, unless it is low quality")', () => {
  it('recommends the last take outright when it clears the low-confidence bar', () => {
    const take1 = mkWords('r1w', SHIBUYA, 0, { p: [0.9, 0.9, 0.9, 0.9, 0.9] });
    const take2 = mkWords('r2w', SHIBUYA, endOf(take1) + 2.0, { p: [0.9, 0.9, 0.9, 0.9, 0.9] });
    const groups = detectTakes(mkTranscript([...take1, ...take2]));
    expect(groups).toHaveLength(1);
    expect(groups[0].recommendation.utteranceIndex).toBe(1);
  });

  it('falls back to an earlier, cleaner take when the last take is low-confidence (>30% words below the confidence threshold)', () => {
    const good = mkWords('f1w', SHIBUYA, 0, { p: [0.9, 0.9, 0.9, 0.9, 0.9] });
    // last take: 2/5 = 40% low-confidence words, above LOW_CONFIDENCE_RECOMMEND_THRESHOLD (0.3)
    const bad = mkWords('f2w', SHIBUYA, endOf(good) + 2.0, { p: [0.2, 0.2, 0.9, 0.9, 0.9] });
    const groups = detectTakes(mkTranscript([...good, ...bad]));
    expect(groups).toHaveLength(1);
    const group = groups[0];
    expect(group.utterances[1].features.lowConfidenceRatio).toBeCloseTo(0.4);
    expect(group.recommendation.utteranceIndex).toBe(0); // falls back to the earlier, clean take
    expect(group.recommendation.reason).toContain('次点');
  });

  it('sticks with the last take when every take is equally (or more) low-confidence — it is still the least-bad option', () => {
    const bad1 = mkWords('s1w', SHIBUYA, 0, { p: [0.1, 0.1, 0.1, 0.9, 0.9] }); // 40% low-conf
    const bad2 = mkWords('s2w', SHIBUYA, endOf(bad1) + 2.0, { p: [0.1, 0.1, 0.1, 0.9, 0.9] }); // same 40%
    const groups = detectTakes(mkTranscript([...bad1, ...bad2]));
    expect(groups).toHaveLength(1);
    expect(groups[0].recommendation.utteranceIndex).toBe(1);
  });
});

describe('detectTakes — utterance features', () => {
  it('computes duration, lowConfidenceRatio, fillerCount, and repetitionRatio per utterance', () => {
    const clean = mkWords('feat1', SHIBUYA, 0, { p: [0.9, 0.9, 0.9, 0.9, 0.9] });
    // second take: opens with a filler ("えっと") and stutters ("渋谷" said twice in a row)
    const withFillerAndStutter = mkWords('feat2', ['えっと', '今日', 'は', '渋谷', '渋谷', 'に', '来ました'], endOf(clean) + 2.0, {
      p: [0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9],
    });
    const groups = detectTakes(mkTranscript([...clean, ...withFillerAndStutter]));
    expect(groups).toHaveLength(1);
    const [u1, u2] = groups[0].utterances;
    expect(u1.features.duration).toBeGreaterThan(0);
    expect(u1.features.fillerCount).toBe(0);
    expect(u1.features.repetitionRatio).toBe(0);
    expect(u2.features.fillerCount).toBe(1); // "えっと"
    expect(u2.features.repetitionRatio).toBeCloseTo(1 / 6); // one repeated pair ("渋谷","渋谷") out of 6 adjacent pairs
  });
});

describe('packTakes — director-facing compact text', () => {
  it('renders a placeholder when no groups were detected', () => {
    expect(packTakes([])).toBe('(no multi-take groups detected)');
  });

  it('renders each group with a recommendation marker and readable timestamps', () => {
    const take1 = mkWords('p1w', SHIBUYA, 0);
    const take2 = mkWords('p2w', SHIBUYA, endOf(take1) + 2.5);
    const groups = detectTakes(mkTranscript([...take1, ...take2]));
    const packed = packTakes(groups);
    expect(packed).toContain('multi-take groups (1 detected');
    expect(packed).toContain('今日は渋谷に来ました');
    expect(packed).toContain('★');
    expect(packed).toContain('推薦');
    // recommended take (index 1, the last) is the one carrying the marker
    const recommendedLine = packed.split('\n').find((l) => l.includes('★'));
    expect(recommendedLine).toBeDefined();
    expect(recommendedLine).toContain(groups[0].utterances[1].text);
  });
});

describe('LOW_CONFIDENCE_RECOMMEND_THRESHOLD', () => {
  it('is 0.3 (30% of an utterance flagged low-confidence disqualifies it as the default pick)', () => {
    expect(LOW_CONFIDENCE_RECOMMEND_THRESHOLD).toBe(0.3);
  });
});
