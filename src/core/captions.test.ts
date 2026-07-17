import { describe, expect, it } from 'vitest';
import { captionCueKey, captionCues, sanitizeCaptionText } from './captions.js';
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

  describe('sourceId/key (W-CAP)', () => {
    it('every cue carries sourceId and a key of `${sourceId}:${wordIds[0]}`', () => {
      const m = manifest([{ srcIn: 0, srcOut: 20 }]);
      const words: Word[] = [
        { id: 'w0', text: 'Hello.', t0: 1.0, t1: 1.5, p: 0.9 },
        { id: 'w1', text: 'World.', t0: 5.0, t1: 5.5, p: 0.9 },
      ];
      const t: Transcript = { sourceId: 's1', language: 'en', words };
      const cues = captionCues(m, [t]);
      expect(cues).toHaveLength(2);
      expect(cues[0].sourceId).toBe('s1');
      expect(cues[0].key).toBe('s1:w0');
      expect(cues[0].key).toBe(captionCueKey('s1', 'w0'));
      expect(cues[1].key).toBe('s1:w1');
    });

    it('a merged cue (CPS-floor merge) keeps the chronologically-earlier cue\'s key', () => {
      const m = manifest([{ srcIn: 0, srcOut: 20 }]);
      // Same fixture as the "regression" CPS-floor test above: too-short
      // adjacent cues merge into one.
      const words: Word[] = [
        { id: 'w0', text: 'では、また次回!', t0: 10, t1: 10.05, p: 0.9 },
        { id: 'w1', text: 'next.', t0: 10.3, t1: 10.6, p: 0.9 },
      ];
      const t: Transcript = { sourceId: 's1', language: 'ja', words };
      const cues = captionCues(m, [t]);
      expect(cues).toHaveLength(1);
      expect(cues[0].key).toBe('s1:w0');
    });
  });

  describe('captionTextOverrides (W-CAP)', () => {
    function words(): Word[] {
      return [
        { id: 'w0', text: 'Hello.', t0: 1.0, t1: 1.5, p: 0.9 },
        { id: 'w1', text: 'World.', t0: 5.0, t1: 5.5, p: 0.9 },
      ];
    }
    function transcript(): Transcript {
      return { sourceId: 's1', language: 'en', words: words() };
    }

    it('replaces a cue\'s text and records the original under originalText', () => {
      const base = manifest([{ srcIn: 0, srcOut: 20 }]);
      const m: Manifest = { ...base, captionTextOverrides: { 's1:w0': 'Bonjour.' } };
      const cues = captionCues(m, [transcript()]);
      expect(cues[0].text).toBe('Bonjour.');
      expect(cues[0].originalText).toBe('Hello.');
      // The untouched cue is unaffected — no originalText at all.
      expect(cues[1].text).toBe('World.');
      expect(cues[1].originalText).toBeUndefined();
    });

    it('an empty-string override hides that cue entirely, leaving the others untouched', () => {
      const base = manifest([{ srcIn: 0, srcOut: 20 }]);
      const m: Manifest = { ...base, captionTextOverrides: { 's1:w0': '' } };
      const cues = captionCues(m, [transcript()]);
      expect(cues).toHaveLength(1);
      expect(cues[0].key).toBe('s1:w1');
    });

    it('a key that does not match any cue is silently ignored (no crash, no effect)', () => {
      const base = manifest([{ srcIn: 0, srcOut: 20 }]);
      const m: Manifest = { ...base, captionTextOverrides: { 's1:w999': 'nope' } };
      const cues = captionCues(m, [transcript()]);
      expect(cues.map((c) => c.text)).toEqual(['Hello.', 'World.']);
    });

    it('absent captionTextOverrides is a full regression — cues identical to no overrides at all', () => {
      const base = manifest([{ srcIn: 0, srcOut: 20 }]);
      const withField = captionCues({ ...base, captionTextOverrides: {} }, [transcript()]);
      const without = captionCues(base, [transcript()]);
      expect(withField.map((c) => ({ text: c.text, tlStart: c.tlStart, tlEnd: c.tlEnd }))).toEqual(
        without.map((c) => ({ text: c.text, tlStart: c.tlStart, tlEnd: c.tlEnd })),
      );
    });
  });
});
