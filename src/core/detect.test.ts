import { describe, expect, it } from 'vitest';
import { detectFillers, detectSilencesFromPeaks } from './detect.js';
import type { Transcript, Word } from './types.js';

describe('detectSilencesFromPeaks — hysteresis + minimum speech length', () => {
  it('regression: keeps a ~1s silence candidate intact through a brief sub-exit-threshold peak (used to vanish entirely)', () => {
    const rate = 25; // 1 sample = 40ms
    const peaks = new Array(25).fill(0.01); // 1.0s of near-silence
    peaks[12] = 0.08; // brief peak: crosses the plain threshold but not exit (threshold*1.4)
    const out = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', threshold: 0.06, minGap: 0.7, pad: 0 });
    expect(out).toHaveLength(1);
    expect(out[0].t1 - out[0].t0).toBeCloseTo(1.0, 1);
  });

  it('sanity check: with both new mechanisms disabled (exitMultiplier=1, minSpeechLen=0), the same peak reproduces the old single-threshold bug — the run splits into two too-short candidates that both vanish', () => {
    const rate = 25;
    const peaks = new Array(25).fill(0.01);
    peaks[12] = 0.08;
    const out = detectSilencesFromPeaks(
      { rate, peaks },
      { sourceId: 's1', threshold: 0.06, minGap: 0.7, pad: 0, exitMultiplier: 1, minSpeechLen: 0 },
    );
    expect(out).toHaveLength(0);
  });

  it('merges a sub-80ms noise spike back into silence instead of splitting one region into two candidates', () => {
    const rate = 25;
    const peaks = [...Array(20).fill(0.01), 0.5, ...Array(20).fill(0.01)]; // 20 silent + 1 loud spike (40ms) + 20 silent
    const out = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', threshold: 0.06, minGap: 0.7, pad: 0 });
    expect(out).toHaveLength(1);
    expect(out[0].t1 - out[0].t0).toBeCloseTo(41 / 25, 2);
  });

  it('does not merge a speech burst at or above the 80ms minimum — two genuine silences stay separate', () => {
    const rate = 25;
    const peaks = [...Array(20).fill(0.01), 0.5, 0.5, ...Array(20).fill(0.01)]; // 20 silent + 2-sample(80ms) loud burst + 20 silent
    const out = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', threshold: 0.06, minGap: 0.7, pad: 0 });
    expect(out).toHaveLength(2);
  });
});

describe('detectFillers — n-gram matching', () => {
  it('matches a filler that whisper split across two tokens (n-gram: えー + と → えーと)', () => {
    const t: Transcript = {
      sourceId: 's1',
      language: 'ja',
      words: [
        { id: 'w0', text: 'これは', t0: 0, t1: 0.5, p: 0.9 },
        { id: 'w1', text: 'えー', t0: 1.0, t1: 1.3, p: 0.9 }, // gap 0.5s before
        { id: 'w2', text: 'と', t0: 1.3, t1: 1.5, p: 0.9 }, // contiguous with w1
        { id: 'w3', text: 'テスト', t0: 2.0, t1: 2.5, p: 0.9 }, // gap 0.5s after
      ],
    };
    const out = detectFillers(t);
    expect(out).toHaveLength(1);
    expect(out[0].wordIds).toEqual(['w1', 'w2']);
    expect(out[0].t0).toBeCloseTo(1.0);
    expect(out[0].t1).toBeCloseTo(1.5);
  });

  it('matches a space-delimited multi-word filler ("you know")', () => {
    const t: Transcript = {
      sourceId: 's1',
      language: 'en',
      words: [
        { id: 'w0', text: 'well', t0: 0, t1: 0.3, p: 0.9 },
        { id: 'w1', text: 'you', t0: 1.0, t1: 1.2, p: 0.9 },
        { id: 'w2', text: 'know', t0: 1.2, t1: 1.4, p: 0.9 },
        { id: 'w3', text: 'right', t0: 2.0, t1: 2.3, p: 0.9 },
      ],
    };
    const out = detectFillers(t);
    expect(out).toHaveLength(1);
    expect(out[0].wordIds).toEqual(['w1', 'w2']);
  });

  it('normalizes full-width characters via NFKC before matching', () => {
    const words: Word[] = [
      { id: 'w0', text: 'ok', t0: 0, t1: 0.3, p: 0.9 },
      { id: 'w1', text: 'ＵＭ', t0: 1.0, t1: 1.2, p: 0.9 }, // full-width "UM"
      { id: 'w2', text: 'next', t0: 2.0, t1: 2.3, p: 0.9 },
    ];
    const t: Transcript = { sourceId: 's1', language: 'en', words };
    const out = detectFillers(t);
    expect(out).toHaveLength(1);
    expect(out[0].wordIds).toEqual(['w1']);
  });

  it('requires a stricter 0.25s flank gap for ambiguous filler words like "so" — moderately-flanked "so" is kept, not flagged', () => {
    const words: Word[] = [
      { id: 'w0', text: 'anyway', t0: 0, t1: 0.3, p: 0.9 },
      { id: 'w1', text: 'so', t0: 0.5, t1: 0.6, p: 0.9 }, // before = 0.2s
      { id: 'w2', text: 'yeah', t0: 0.8, t1: 1.1, p: 0.9 }, // after = 0.2s
    ];
    const t: Transcript = { sourceId: 's1', language: 'en', words };
    expect(detectFillers(t)).toHaveLength(0); // both gaps < 0.25 (strict) → mid-sentence, kept
  });

  it('still flags a clearly isolated "so" (a large gap on at least one side) despite the stricter threshold', () => {
    const words: Word[] = [
      { id: 'w0', text: 'anyway', t0: 0, t1: 0.3, p: 0.9 },
      { id: 'w1', text: 'so', t0: 1.0, t1: 1.1, p: 0.9 }, // before = 0.7s
      { id: 'w2', text: 'yeah', t0: 1.3, t1: 1.6, p: 0.9 }, // after = 0.2s
    ];
    const t: Transcript = { sourceId: 's1', language: 'en', words };
    expect(detectFillers(t)).toHaveLength(1);
  });

  it('contrast: a non-ambiguous filler ("um") with the same 0.2s/0.2s gaps still gets flagged under the default (non-strict) threshold', () => {
    const words: Word[] = [
      { id: 'w0', text: 'anyway', t0: 0, t1: 0.3, p: 0.9 },
      { id: 'w1', text: 'um', t0: 0.5, t1: 0.6, p: 0.9 },
      { id: 'w2', text: 'yeah', t0: 0.8, t1: 1.1, p: 0.9 },
    ];
    const t: Transcript = { sourceId: 's1', language: 'en', words };
    expect(detectFillers(t)).toHaveLength(1);
  });
});

describe('waveform vs transcript conflict (soft speech)', () => {
  it('surfaces a strongly-quiet window overlapped by claimed speech, flagged for preview', async () => {
    const { detectSilencesFromPeaks } = await import('./detect.js');
    const rate = 25;
    // 1s loud, 2s quiet, 1s loud — transcript claims a word inside the quiet
    const peaks = [...Array(rate).fill(0.5), ...Array(rate * 2).fill(0.01), ...Array(rate).fill(0.5)];
    const words = [
      { id: 'w0', text: 'a', t0: 0.2, t1: 0.9, p: 0.9 },
      { id: 'w1', text: 'ふふ', t0: 1.0, t1: 2.6, p: 0.8 }, // covers most of the quiet
      { id: 'w2', text: 'b', t0: 3.1, t1: 3.8, p: 0.9 },
    ];
    const cands = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', words });
    expect(cands).toHaveLength(1);
    expect(cands[0].label).toContain('transcript disagrees');
  });
  it('still drops weak-evidence windows that clamp below minGap', async () => {
    const { detectSilencesFromPeaks } = await import('./detect.js');
    const rate = 25;
    // quiet window only 0.8s (< minGap*1.5), word covers half of it
    const peaks = [...Array(rate).fill(0.5), ...Array(Math.round(rate * 0.8)).fill(0.01), ...Array(rate).fill(0.5)];
    const words = [{ id: 'w0', text: 'x', t0: 1.0, t1: 1.5, p: 0.9 }];
    const cands = detectSilencesFromPeaks({ rate, peaks }, { sourceId: 's1', words, minGap: 0.7 });
    expect(cands).toHaveLength(0);
  });
});
