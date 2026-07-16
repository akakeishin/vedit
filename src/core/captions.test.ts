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
});
