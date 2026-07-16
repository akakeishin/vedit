import { describe, expect, it } from 'vitest';
import { toSrt } from './srt.js';
import type { Manifest, Transcript } from '../core/types.js';

function manifest(): Manifest {
  return {
    version: 1,
    name: 't',
    revision: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    sources: [{ id: 's1', path: '/x.mp4', duration: 10, fps: 30, width: 1920, height: 1080, hasAudio: true }],
    timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 10 }], motion: [] },
    captions: { enabled: true, style: 'clean', maxChars: 24 },
  };
}

// Each word ends with a sentence-terminating period so captionCues flushes
// it as its own cue deterministically, independent of the 0.6s pause rule —
// keeps this a pure test of toSrt's formatting, not of caption line-breaking.
function transcript(): Transcript {
  return {
    sourceId: 's1',
    language: 'en',
    words: [
      { id: 'w0', text: 'Hello.', t0: 1.0, t1: 2.0, p: 0.95 },
      { id: 'w1', text: 'World.', t0: 5.0, t1: 6.0, p: 0.95 },
    ],
  };
}

describe('toSrt', () => {
  it('renders numbered cues with comma-separated SRT timecodes', () => {
    const srt = toSrt(manifest(), [transcript()]);
    expect(srt).toBe(
      '1\n00:00:01,500 --> 00:00:02,150\nHello.\n' +
        '\n' +
        '2\n00:00:05,500 --> 00:00:06,150\nWorld.\n',
    );
  });

  it('returns an empty string when there is nothing to caption', () => {
    expect(toSrt(manifest(), [])).toBe('');
  });

  it('returns an empty string when captions are disabled', () => {
    const m = { ...manifest(), captions: { ...manifest().captions, enabled: false } };
    expect(toSrt(m, [transcript()])).toBe('');
  });

  it('rolls milliseconds over into seconds/minutes cleanly instead of truncating', () => {
    // A word landing right at a minute boundary must not render as
    // "00:00:59,999" one frame short of "00:01:00,000".
    const m: Manifest = {
      ...manifest(),
      timeline: { video: [{ id: 'c1', sourceId: 's1', srcIn: 0, srcOut: 65 }], motion: [] },
    };
    const t: Transcript = {
      sourceId: 's1',
      language: 'en',
      words: [{ id: 'w0', text: 'late.', t0: 59.9996, t1: 60.0004, p: 0.9 }],
    };
    const srt = toSrt(m, [t]);
    expect(srt).toContain('00:01:00,000 -->');
  });
});
