import { describe, expect, it } from 'vitest';
import { captionCues, sanitizeCaptionText } from './captions.js';
import type { Manifest, Transcript, Word } from './types.js';

function manifest(clips: { srcIn: number; srcOut: number }[] = [{ srcIn: 0, srcOut: 20 }]): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/x.mp4', duration: 30, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: {
      video: clips.map((c, i) => ({ id: `c${i}`, sourceId: 's1', srcIn: c.srcIn, srcOut: c.srcOut })),
      motion: [],
    },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

describe('sanitizeCaptionText', () => {
  it('normalizes runs of whitespace', () => {
    expect(sanitizeCaptionText('hello    world  ')).toBe('hello world');
  });

  it('strips unmatched brackets of a given type but keeps balanced ones', () => {
    expect(sanitizeCaptionText('это「変な引用符')).toBe('это変な引用符');
    expect(sanitizeCaptionText('「バランス」オーケー')).toBe('「バランス」オーケー');
    expect(sanitizeCaptionText('a (note that trails off')).toBe('a note that trails off');
    expect(sanitizeCaptionText('a (balanced note)')).toBe('a (balanced note)');
  });
});

describe('captionCues', () => {
  it('clamps a cue past the end of the timeline', () => {
    const m = manifest([{ srcIn: 0, srcOut: 5 }]); // 5s timeline
    const words: Word[] = [
      { id: 'w0', text: 'hello', t0: 0, t1: 1, p: 0.9 },
      { id: 'w1', text: 'there', t0: 1, t1: 4.9, p: 0.9 }, // near-end word, cue would overhang past 5s
    ];
    const t: Transcript = { sourceId: 's1', language: 'en', words };
    const cues = captionCues(m, [t]);
    for (const c of cues) expect(c.tlEnd).toBeLessThanOrEqual(5);
  });

  it('truncates a cue that would overlap the next one', () => {
    const m = manifest([{ srcIn: 0, srcOut: 15 }]);
    // A single long-duration word fills the maxChars budget and forces a
    // line break right as the next word starts almost immediately after —
    // the first cue's tail padding (word end + 0.15s) then overshoots past
    // the second cue's start.
    const words: Word[] = [
      { id: 'w0', text: 'aaaaaaaaaaaaaaaaaaaaaaaa', t0: 0, t1: 10, p: 0.9 }, // 24 chars == maxChars
      { id: 'w1', text: 'b', t0: 10.05, t1: 10.1, p: 0.9 },
      { id: 'w2', text: 'c', t0: 10.1, t1: 10.2, p: 0.9 },
    ];
    const t: Transcript = { sourceId: 's1', language: 'en', words };
    const cues = captionCues(m, [t]);
    expect(cues.length).toBe(2);
    expect(cues[0].tlEnd).toBeLessThanOrEqual(cues[1].tlStart);
  });

  it('drops a cue that sanitizes down to nothing', () => {
    const m = manifest([{ srcIn: 0, srcOut: 5 }]);
    const words: Word[] = [{ id: 'w0', text: '「', t0: 0, t1: 0.5, p: 0.9 }];
    const t: Transcript = { sourceId: 's1', language: 'ja', words };
    const cues = captionCues(m, [t]);
    expect(cues).toHaveLength(0);
  });

  describe('minimum display duration (CPS floor)', () => {
    it('regression: a cue truncated below 0.6s by de-overlap gets merged with its neighbor instead of flashing by (real case: "では、また次回!" at 121ms)', () => {
      const m = manifest([{ srcIn: 0, srcOut: 20 }]);
      const words: Word[] = [
        // Short, punctuation-terminated utterance: flushes immediately as its
        // own cue with the 0.6s floor from captionCues' own flush() logic.
        { id: 'w0', text: 'では、また次回!', t0: 10, t1: 10.05, p: 0.9 },
        // The next cue starts soon enough after that de-overlap truncates the
        // first cue's tail well below 0.6s again.
        { id: 'w1', text: 'next.', t0: 10.3, t1: 10.6, p: 0.9 },
      ];
      const t: Transcript = { sourceId: 's1', language: 'ja', words };
      const cues = captionCues(m, [t]);
      // Not enough idle time anywhere to borrow from, so the two cues merge
      // into one that comfortably clears both the 0.6s floor and its CPS need.
      expect(cues).toHaveLength(1);
      expect(cues[0].tlEnd - cues[0].tlStart).toBeGreaterThanOrEqual(0.6);
      expect(cues[0].text).toContain('では、また次回!');
      expect(cues[0].text).toContain('next.');
      expect(cues[0].wordIds).toEqual(['w0', 'w1']);
    });

    it('extends a too-short cue by borrowing idle time instead of merging, when enough room exists', () => {
      const m = manifest([{ srcIn: 0, srcOut: 20 }]);
      const words: Word[] = [
        { id: 'w0', text: 'ではまた明日もよろしくお願いいたします!', t0: 5, t1: 5.1, p: 0.9 },
      ];
      const t: Transcript = { sourceId: 's1', language: 'ja', words };
      const cues = captionCues(m, [t]);
      expect(cues).toHaveLength(1);
      const need = Math.max(0.6, cues[0].text.length / 8);
      expect(cues[0].tlEnd - cues[0].tlStart).toBeGreaterThanOrEqual(need - 1e-6);
    });

    it('respects a custom maxCps from CaptionSettings instead of the default 8', () => {
      const base = manifest([{ srcIn: 0, srcOut: 20 }]);
      const m: Manifest = { ...base, captions: { ...base.captions, maxCps: 100 } }; // very lenient
      const words: Word[] = [
        { id: 'w0', text: 'ではまた明日もよろしくお願いいたします!', t0: 5, t1: 5.1, p: 0.9 },
      ];
      const t: Transcript = { sourceId: 's1', language: 'ja', words };
      const cues = captionCues(m, [t]);
      expect(cues).toHaveLength(1);
      // With maxCps=100 the CPS requirement is trivially satisfied by the
      // existing 0.6s flush floor — no extension needed.
      expect(cues[0].tlEnd - cues[0].tlStart).toBeCloseTo(0.6, 5);
    });
  });
});
